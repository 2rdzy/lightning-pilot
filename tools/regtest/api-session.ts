import { testSpendPolicy } from '../../apps/server/src/testing.ts';
// A server on a fresh database with a completed setup, a logged-in owner with a security step-up, and cln-a added
// with view and spend runes and an unlimited spending policy. Shared by the regtest API tests that need a spend path.
import { totp } from '../../apps/server/src/modules/auth/totp/totp.ts';
import type { SetupAction, SetupProgress } from '../../packages/core/src/setup.ts';
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { loadConfig } from '../../apps/server/src/config/config.ts';
import { createLogger } from '../../apps/server/src/logging/logger.ts';
import { buildServer, type Server, type ServerOptions } from '../../apps/server/src/server.ts';
import { tempDir, writeVaultKey } from '../../apps/server/src/testing.ts';
import { creds, profileOf, type RegtestChain } from './nodes.ts';

export interface ApiSession {
  server: Server;
  dir: string;
  vaultKey: string;
  lines: string[];
  auth: { cookie: string; csrf: string };
  nodeId: string;
  password: string;
  secret: string;
  request: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  // A fresh step-up of the given strength; the session cookie rotates.
  stepUp: (strength: 'password' | 'security') => Promise<void>;
  // Closes the server, so another process can use the data directory.
  suspend: () => Promise<void>;
  // Closes the current server (if open) and opens a new one on the same data directory.
  reopen: (options?: Partial<ServerOptions>) => Promise<Server>;
  cleanup: () => Promise<void>;
}

export async function ok<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : undefined) as T;
}

export function serverOptions(dir: string, vaultKey: string, lines: string[]): ServerOptions {
  const { config } = loadConfig({
    readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: dir, vaultKey } }),
  });
  return {
    config,
    vaultKeyPath: vaultKey,
    dev: true,
    logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }),
  };
}

export async function apiSession(chain: RegtestChain): Promise<ApiSession> {
  const temp = tempDir();
  const vaultKey = writeVaultKey(temp.dir);
  const lines: string[] = [];
  let server = await buildServer(serverOptions(temp.dir, vaultKey, lines));
  let open = true;
  const close = async () => {
    if (open) await server.close();
    open = false;
  };
  let auth: { cookie: string; csrf: string } | undefined;
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    Promise.resolve(
      server.app.request(path, {
        method,
        headers: {
          host: 'localhost',
          origin: 'https://localhost',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const password = `Regtest-${randomBytes(8).toString('hex')}!A`;
  const line = lines.find((l) => l.includes('"setupToken"'));
  const token = (JSON.parse(line ?? '{}') as { setupToken: string }).setupToken;
  const start = await request('POST', '/api/v1/setup', { action: 'start', token });
  const progress = await ok<SetupProgress>(start);
  const setupCookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const act = async (action: SetupAction) =>
    ok<SetupProgress>(
      await request('POST', '/api/v1/setup', action, { cookie: setupCookie, 'x-csrf-token': progress.csrfToken }),
    );
  const secret = (await act({ action: 'password', password })).secret;
  if (!secret) throw new Error('No TOTP enrolment secret');
  const recovery = await act({ action: 'totp', code: totp(secret, new Date(Date.now() - 30_000)) });
  const code = recovery.recoveryCodes?.[0];
  if (!code) throw new Error('No recovery code');
  await act({ action: 'recovery', code });
  await act({ action: 'backup', confirmed: true });
  await act({ action: 'node', node: null });
  await act({ action: 'alerts', alerts: { kind: 'none' } });
  await act({ action: 'complete' });
  const login = await request('POST', '/api/v1/auth/login', { password, totpCode: totp(secret, new Date()) });
  const session = await ok<{ csrfToken: string }>(login);
  auth = { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '', csrf: session.csrfToken };
  const stepUp = await request('POST', '/api/v1/auth/step-up', {
    password,
    strength: 'security',
    totpCode: totp(secret, new Date(Date.now() + 30_000)),
  });
  const stepped = await ok<{ csrfToken: string }>(stepUp);
  auth = { cookie: (stepUp.headers.get('set-cookie') ?? '').split(';')[0] ?? '', csrf: stepped.csrfToken };

  const view = creds(chain, 'cln-a', 'view');
  const spend = creds(chain, 'cln-a', 'spend');
  const node = await ok<{ id: string }>(
    await request('POST', '/api/v1/nodes', {
      name: 'cln-a',
      chain: profileOf(chain),
      network: 'regtest',
      implementation: 'cln',
      url: view.url,
      caCertificate: view.caCertificate,
      serverName: view.serverName,
      viewRune: view.rune,
      spendRune: spend.rune,
      limits: testSpendPolicy,
    }),
    201,
  );
  await ok(
    await request('POST', `/api/v1/nodes/${node.id}/spend-policy`, {
      maxPerPayment: null,
      max24h: null,
      stepUpAbove: null,
      maxFeeRate: '50',
      maxFeeSharePercent: 50,
      maxRoutingFeeSharePercent: 1,
      routingFeeAllowance: '10',
    }),
    204,
  );

  const result: ApiSession = {
    get server() {
      return server;
    },
    dir: temp.dir,
    vaultKey,
    lines,
    get auth() {
      return auth as { cookie: string; csrf: string };
    },
    nodeId: node.id,
    password,
    secret,
    request,
    stepUp: async (strength) => {
      const res = await request('POST', '/api/v1/auth/step-up', {
        password,
        strength,
        ...(strength === 'security' ? { totpCode: totp(secret, new Date(Date.now() + 60_000)) } : {}),
      });
      const body = await ok<{ csrfToken: string }>(res);
      auth = { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '', csrf: body.csrfToken };
    },
    suspend: close,
    reopen: async (options = {}) => {
      await close();
      server = await buildServer({ ...serverOptions(temp.dir, vaultKey, lines), issueSetupToken: false, ...options });
      open = true;
      return server;
    },
    cleanup: async () => {
      await close();
      temp.cleanup();
    },
  };
  return result;
}
