// Walking-skeleton end-to-end test over the API, against the tools/regtest nodes of one chain (LP_REGTEST_CHAIN):
// from a fresh database, setup → login → add cln-a → node info and balances → pay an invoice made on cln-c →
// receive a payment from cln-c. Every log line of the run is kept and checked for secrets at the end.
import type { SetupAction, SetupProgress } from '../../packages/core/src/setup.ts';
import { totp } from '../../apps/server/src/modules/auth/totp/totp.ts';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/server/src/config/config.ts';
import { createLogger } from '../../apps/server/src/logging/logger.ts';
import { buildServer, type Server } from '../../apps/server/src/server.ts';
import { tempDir, writeVaultKey } from '../../apps/server/src/testing.ts';
import { cli, creds, invoiceOn, isPaidOn, profileOf, regtest, regtestChain } from './nodes.ts';

const chain = regtestChain();
if (!chain) throw new Error('set LP_REGTEST_CHAIN to blake2b or sha256d');
const profile = profileOf(chain);
const otherProfile = profile === 'blake2b' ? 'bitcoin' : 'blake2b';

const PASSWORD = `E2e-${randomBytes(8).toString('hex')}!A`;
const lines: string[] = [];
const secrets: string[] = [PASSWORD];
let server: Server;
let cleanup: () => void;
let auth: { cookie: string; csrf: string };
let nodeId: string;

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return Promise.resolve(
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
}

async function ok<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : undefined) as T;
}

beforeAll(async () => {
  const dir = tempDir();
  cleanup = dir.cleanup;
  const vaultKey = writeVaultKey(dir.dir);
  const { config } = loadConfig({
    readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: dir.dir, vaultKey } }),
  });
  const logger = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  server = await buildServer({ config, vaultKeyPath: vaultKey, dev: true, logger });
});

afterAll(async () => {
  await server.close();
  cleanup();
});

describe(`end to end on ${chain} (profile ${profile})`, () => {
  it('completes setup with the token from the log, then logs in', async () => {
    const line = lines.find((l) => l.includes('"setupToken"'));
    const token = (JSON.parse(line ?? '{}') as { setupToken: string }).setupToken;
    expect(token).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
    const start = await request('POST', '/api/v1/setup', { action: 'start', token });
    const progress = await ok<SetupProgress>(start);
    const setupCookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const act = async (action: SetupAction) =>
      ok<SetupProgress>(
        await request('POST', '/api/v1/setup', action, {
          cookie: setupCookie,
          'x-csrf-token': progress.csrfToken,
        }),
      );
    const enrolment = await act({ action: 'password', password: PASSWORD });
    const secret = enrolment.secret;
    if (!secret) throw new Error('No TOTP enrolment secret');
    secrets.push(secret);
    const recovery = await act({ action: 'totp', code: totp(secret, new Date(Date.now() - 30_000)) });
    const code = recovery.recoveryCodes?.[0];
    if (!code) throw new Error('No recovery code');
    secrets.push(...(recovery.recoveryCodes ?? []));
    await act({ action: 'recovery', code });
    await act({ action: 'backup', confirmed: true });
    await act({ action: 'node', node: null });
    await act({ action: 'alerts', alerts: { kind: 'none' } });
    const complete = await act({ action: 'complete' });
    expect(complete.step).toBe('done');
    expect(complete.session).toBeDefined();
    const res = await request('POST', '/api/v1/auth/login', { password: PASSWORD, totpCode: totp(secret, new Date()) });
    const session = await ok<{ csrfToken: string }>(res);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    auth = { cookie, csrf: session.csrfToken };
    secrets.push(cookie.split('=')[1] ?? '', session.csrfToken);
  });

  it('refuses the node under the other chain profile', async () => {
    const view = creds(chain, 'cln-a', 'view');
    const res = await request('POST', '/api/v1/nodes', {
      name: 'wrong profile',
      chain: otherProfile,
      network: 'regtest',
      implementation: 'cln',
      url: view.url,
      caCertificate: view.caCertificate,
      viewRune: view.rune,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('chain_refused');
  });

  it('adds cln-a with a view and a spend rune; the chain identity is confirmed', async () => {
    const view = creds(chain, 'cln-a', 'view');
    const spend = creds(chain, 'cln-a', 'spend');
    secrets.push(view.rune, spend.rune);
    const node = await ok<{ id: string; pubkey: string; canSpend: boolean; chainIdentity: { state: string } }>(
      await request('POST', '/api/v1/nodes', {
        name: 'cln-a',
        chain: profile,
        network: 'regtest',
        implementation: 'cln',
        url: view.url,
        caCertificate: view.caCertificate,
        serverName: view.serverName,
        viewRune: view.rune,
        spendRune: spend.rune,
      }),
      201,
    );
    expect(node).toMatchObject({ pubkey: view.pubkey, canSpend: true, chainIdentity: { state: 'confirmed' } });
    nodeId = node.id;
  });

  it('reads node info and balances', async () => {
    const info = await ok<{ pubkey: string; numActiveChannels: number; chain: string }>(
      await request('GET', `/api/v1/nodes/${nodeId}`),
    );
    expect(info.chain).toBe(profile);
    expect(info.numActiveChannels).toBeGreaterThanOrEqual(2);
    const balances = await ok<{ lightning: { spendable: string } }>(
      await request('GET', `/api/v1/nodes/${nodeId}/balances`),
    );
    expect(BigInt(balances.lightning.spendable)).toBeGreaterThan(100_000n);
  });

  it('pays an invoice made on another node through preview and confirmation', async () => {
    const bolt11 = invoiceOn(chain, 'cln-c', 33_000n, `e2e-${Date.now()}`);
    secrets.push(bolt11);
    const preview = await ok<{ confirmationToken: string; decoded: { paymentHash: string }; cost: { amount: string } }>(
      await request('POST', `/api/v1/nodes/${nodeId}/payments/preview`, { request: bolt11 }),
    );
    expect(preview.cost.amount).toBe('33000');
    secrets.push(preview.confirmationToken);
    const key = `e2e-${randomBytes(12).toString('hex')}`;
    const result = await ok<{ state: string; paymentHash: string; preimage: string; intentId: string }>(
      await request(
        'POST',
        `/api/v1/nodes/${nodeId}/payments/execute`,
        { confirmationToken: preview.confirmationToken },
        { 'idempotency-key': key },
      ),
    );
    expect(result.state).toBe('succeeded');
    expect(result.paymentHash).toBe(preview.decoded.paymentHash);
    secrets.push(result.preimage);
    expect(isPaidOn(chain, 'cln-c', result.paymentHash)).toBe(true);
    // The node stored our intent id with the payment, so the outcome can be found after a crash.
    const pays = cli(chain, 'cln-a', 'listpays', '-k', `payment_hash=${result.paymentHash}`) as {
      pays: { label?: string }[];
    };
    expect(pays.pays[0]?.label).toBe(result.intentId);
  });

  it('creates an invoice that another node pays', async () => {
    const invoice = await ok<{ bolt11: string; paymentHash: string }>(
      await request('POST', `/api/v1/nodes/${nodeId}/invoices`, { amount: '12000', description: 'e2e receive' }),
      201,
    );
    // xpay prints a progress line before its JSON, so its output is not parsed.
    regtest(chain, 'cli', 'cln-c', 'xpay', invoice.bolt11);
    const listed = cli(chain, 'cln-a', 'listinvoices', '-k', `payment_hash=${invoice.paymentHash}`) as {
      invoices: { status: string }[];
    };
    expect(listed.invoices[0]?.status).toBe('paid');
  });

  it('wrote no secret to the log during the run', () => {
    expect(lines.length).toBeGreaterThan(5);
    const tokenLines = lines.filter((l) => l.includes('"setupToken"'));
    expect(tokenLines).toHaveLength(1);
    for (const line of lines) {
      for (const secret of secrets.filter((s) => s.length >= 8)) {
        expect(line.includes(secret), `secret ${secret.slice(0, 6)}… in log line ${line.slice(0, 120)}`).toBe(false);
      }
    }
  });
});
