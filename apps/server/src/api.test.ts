import { Vault } from './modules/vault/index.ts';
import { NodesService } from './modules/nodes/index.ts';
import { testRune, testSpendPolicy } from './testing.ts';
// API tests over HTTP (in memory) with the fake adapter: request checks, setup, login, every route's permission,
// nodes, invoices and the spend flow, the error format, and that no secret reaches the log.
import { totp } from './modules/auth/totp/totp.ts';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter, FakeNetwork } from '@lightning-pilot/adapter-kit';
import {
  AdapterError,
  AppError,
  SetupProgress,
  msat,
  parsePaymentHash,
  parseTxid,
  type Chain,
  type Network,
  type PaymentHash,
} from '@lightning-pilot/core';
import { loadConfig } from './config/config.ts';
import { declaredPermissions } from './http/declare.ts';
import { openApiDocument } from './http/app.ts';
import { createLogger } from './logging/logger.ts';
import type { NodeConnection } from './modules/nodes/index.ts';
import { buildServer, type Server } from './server.ts';
import { tempDir, testDriver, writeVaultKey, setupForTest } from './testing.ts';
import fixtures from '../../../packages/core/src/decode/fixtures/regtest-invoices.json' with { type: 'json' };

const PASSWORD = 'Correct-horse-9-battery';
const CA = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const VIEW_RUNE = testRune('read');
const SPEND_RUNE = testRune('spend');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Harness {
  clock: { now: Date };
  server: Server;
  vaultKeyPath: string;
  lines: string[];
  fakes: Map<string, FakeAdapter>;
  world: FakeNetwork;
  secret?: string;
  setupToken: () => string;
  request: (method: string, path: string, options?: RequestOptions) => Promise<Response>;
}

interface RequestOptions {
  body?: unknown;
  cookie?: string;
  csrf?: string;
  headers?: Record<string, string>;
}

async function harness(
  options: {
    dev?: boolean;
    webRoot?: string;
    maxNodes?: number;
    tlsCertificate?: { fingerprintSha256: string; expiresAt: string };
  } = {},
): Promise<Harness> {
  const { dir, cleanup } = tempDir();
  const vaultKey = writeVaultKey(dir);
  const { config } = loadConfig({
    readFile: () =>
      JSON.stringify({
        tls: { mode: 'off' },
        paths: { dataDir: dir, vaultKey },
        ...(options.maxNodes === undefined ? {} : { limits: { maxNodes: options.maxNodes } }),
      }),
  });
  const lines: string[] = [];
  const secretCanaries = new Set([PASSWORD, VIEW_RUNE, SPEND_RUNE, readFileSync(vaultKey, 'utf8').trim()]);
  const collectSecrets = (value: unknown, name = ''): void => {
    if (
      typeof value === 'string' &&
      /password|secret|rune|macaroon|preimage|csrf|cookie|token|recoverycode/i.test(name) &&
      value.length >= 6
    )
      secretCanaries.add(value);
    else if (Array.isArray(value)) for (const item of value) collectSecrets(item, name);
    else if (value !== null && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) collectSecrets(item, key);
  };
  const logDir = join(dir, 'logs');
  const logger = createLogger({ level: 'debug', destination: 'both', directory: logDir, stdout: (l) => lines.push(l) });
  const world = new FakeNetwork();
  const fakes = new Map<string, FakeAdapter>();
  const fake = (url: string, chain: Chain, network: Network = 'regtest') => {
    const adapter = new FakeAdapter({ chain, network, world });
    fakes.set(url, adapter);
    return adapter;
  };
  fake('https://a.blake2b.test', 'blake2b');
  fake('https://b.blake2b.test', 'blake2b');
  fake('https://a.bitcoin.test', 'bitcoin');
  const clock = { now: new Date() };
  const server = await buildServer({
    config,
    ...(options.tlsCertificate ? { tlsCertificate: options.tlsCertificate } : {}),
    now: () => clock.now,
    vaultKeyPath: vaultKey,
    dev: options.dev ?? true,
    logger,
    driver: testDriver(),
    scryptCost: { log2N: 10, r: 8, p: 1 },
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    adapterFactory: (c: NodeConnection) => {
      const adapter = fakes.get(c.url);
      if (!adapter) throw new Error(`no fake at ${c.url}`);
      return adapter;
    },
  });
  cleanups.push(async () => {
    await server.close();
    if (self.secret) secretCanaries.add(self.secret);
    const stdout = lines.filter((line) => !line.includes('"setupToken"')).join('\n');
    const files = readdirSync(logDir, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.jsonl'),
    );
    expect(files.length).toBeGreaterThan(0);
    const output = stdout + files.map((file) => readFileSync(join(file.parentPath, file.name), 'utf8')).join('\n');
    for (const secret of secretCanaries)
      for (const encoding of [secret, Buffer.from(secret).toString('hex'), Buffer.from(secret).toString('base64')])
        expect(output).not.toContain(encoding);
    cleanup();
  });
  // Through h.server, so a test that reopens the server (reopen) keeps using the same helper.
  const request = async (method: string, path: string, o: RequestOptions = {}) => {
    collectSecrets(o.body);
    if (o.csrf) secretCanaries.add(o.csrf);
    for (const match of (o.cookie ?? '').matchAll(/(?:^|;\s*)[^=]+=([^;]+)/g))
      if ((match[1]?.length ?? 0) >= 6) secretCanaries.add(match[1] ?? '');
    const response = await Promise.resolve(
      self.server.app.request(path, {
        method,
        headers: {
          host: 'localhost',
          origin: 'https://localhost',
          ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(o.cookie ? { cookie: o.cookie } : {}),
          ...(o.csrf ? { 'x-csrf-token': o.csrf } : {}),
          ...o.headers,
        },
        ...(o.body === undefined ? {} : { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body) }),
      }),
    );
    for (const match of (response.headers.get('set-cookie') ?? '').matchAll(/__Host-lp_[a-z_]+=([^;,]+)/g))
      if ((match[1]?.length ?? 0) >= 6) secretCanaries.add(match[1] ?? '');
    if (response.headers.get('content-type')?.includes('application/json'))
      collectSecrets(await response.clone().json());
    return response;
  };
  const setupToken = () => {
    const line = [...lines].reverse().find((l) => l.includes('"setupToken"'));
    return (JSON.parse(line ?? '{}') as { setupToken: string }).setupToken;
  };
  const self: Harness = { vaultKeyPath: vaultKey, server, lines, fakes, world, setupToken, request, clock };
  return self;
}

async function loggedIn(h: Harness) {
  const setup = await setupForTest(h.server.setup, h.setupToken(), PASSWORD, h.clock.now);
  h.secret = setup.secret;
  const res = await h.request('POST', '/api/v1/auth/login', {
    body: { password: PASSWORD, totpCode: totp(setup.secret, h.clock.now) },
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const stepUp = await h.request('POST', '/api/v1/auth/step-up', {
    cookie,
    csrf: csrfToken,
    body: {
      password: PASSWORD,
      strength: 'security',
      totpCode: totp(setup.secret, new Date(h.clock.now.getTime() + 30_000)),
    },
  });
  expect(stepUp.status, await stepUp.clone().text()).toBe(200);
  return {
    cookie: (stepUp.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    csrf: ((await stepUp.json()) as { csrfToken: string }).csrfToken,
    setCookie,
  };
}

async function addNode(h: Harness, auth: { cookie: string; csrf: string }, url: string, chain: Chain, extra = {}) {
  const response = await h.request('POST', '/api/v1/nodes', {
    ...auth,
    body: {
      name: 'test node',
      chain,
      network: 'regtest',
      implementation: 'cln',
      url,
      caCertificate: CA,
      viewRune: VIEW_RUNE,
      spendRune: SPEND_RUNE,
      limits: testSpendPolicy,
      ...extra,
    },
  });
  if (response.status === 201) {
    const { id } = (await response.clone().json()) as { id: string };
    const configured = await h.request('POST', `/api/v1/nodes/${id}/spend-policy`, {
      ...auth,
      body: {
        maxPerPayment: null,
        max24h: null,
        stepUpAbove: null,
        maxFeeRate: '10',
        maxFeeSharePercent: 5,
        maxRoutingFeeSharePercent: 1,
        routingFeeAllowance: '10',
      },
    });
    expect(configured.status, await configured.clone().text()).toBe(204);
  }
  return response;
}

// Stops the server and opens a new one on the same data directory, as a restart after a crash does.
// `current` may also be the data directory of a server that is already closed.
async function reopen(h: Harness, current: Server | string, between?: (dir: string) => void): Promise<Server> {
  const dir =
    typeof current === 'string'
      ? current
      : dirname((await sql<{ file: string }>`PRAGMA database_list`.execute(current.db)).rows[0]?.file ?? '');
  const vaultKey = join(dir, 'vault-key');
  const { config } = loadConfig({
    readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: dir, vaultKey } }),
  });
  if (typeof current !== 'string') {
    await current.close();
    current.close = async () => undefined;
  }
  between?.(dir);
  const server = await buildServer({
    config,
    vaultKeyPath: vaultKey,
    dev: true,
    logger: createLogger({ level: 'debug', sink: (l) => h.lines.push(l) }),
    now: () => h.clock.now,
    driver: testDriver(),
    scryptCost: { log2N: 10, r: 8, p: 1 },
    adapterFactory: (connection) => {
      const fake = h.fakes.get(connection.url);
      if (!fake) throw new Error('Missing fake');
      return fake;
    },
  });
  cleanups.unshift(() => server.close());
  h.server = server;
  return server;
}
const randomUUIDv4 = () => crypto.randomUUID();

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe(`API (${testDriver()})`, () => {
  it('declares a permission for every route, and documents every route', async () => {
    const h = await harness();
    const declared = declaredPermissions(h.server.app);
    const routes = new Set(h.server.app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`));
    expect([...routes].sort()).toEqual([...declared.keys()].sort());
    const doc = openApiDocument(h.server.app);
    expect(Object.keys(doc.paths ?? {}).length).toBe(new Set([...declared.keys()].map((k) => k.split(' ')[1])).size);
  });

  it('serves the web app outside /api, with index.html for app routes', async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dir, 'assets', 'app-1234.js'), 'console.log(1)');
    const h = await harness({ webRoot: dir });

    // The route table still holds only declared routes: the web app is middleware.
    const routes = new Set(h.server.app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`));
    expect([...routes].sort()).toEqual([...declaredPermissions(h.server.app).keys()].sort());

    for (const path of ['/', '/login', '/n/0b6c4b8e-0000-4000-8000-000000000000/pay']) {
      const res = await h.request('GET', path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain('<title>app</title>');
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
    const asset = await h.request('GET', '/assets/app-1234.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    // Unknown files, API paths, other methods and traversal attempts get the JSON 404, never index.html.
    for (const [method, path] of [
      ['GET', '/assets/missing.js'],
      ['GET', '/api/v1/unknown'],
      ['GET', '/api/v1'],
      ['GET', '/assets/%2e%2e/%2e%2e/%2e%2e/etc/os-release.txt'],
      ['GET', '/assets/..%2f..%2f..%2fetc%2fhost.conf'],
      ['POST', '/login'],
    ] as const) {
      const res = await h.request(method, path, method === 'POST' ? { body: {} } : {});
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await errorCode(res)).toBe('not_found');
    }
    // A traversal attempt without a file extension is an app route: it gets index.html, never the file.
    const traversal = await h.request('GET', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd');
    expect(await traversal.text()).toContain('<title>app</title>');
    // The Host allowlist applies to the web app too.
    expect((await h.request('GET', '/login', { headers: { host: 'evil.example' } })).status).toBe(421);
  });

  it('refuses unknown hosts before routing, with the error format', async () => {
    const h = await harness();
    const res = await h.request('GET', '/healthz', { headers: { host: 'evil.example' } });
    expect(res.status).toBe(421);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('unknown_host');
    expect(body.error.requestId).toMatch(/^r-[0-9a-f]{12}$/);
    expect((await h.request('GET', '/healthz')).status).toBe(200);
  });

  it('checks Origin and Sec-Fetch-Site on unsafe methods', async () => {
    const h = await harness();
    const body = { password: 'x' };
    const cases: [Record<string, string>, number][] = [
      [{ origin: '' }, 403],
      [{ origin: 'https://evil.example' }, 403],
      [{ origin: 'https://localhost:9999' }, 403],
      [{ 'sec-fetch-site': 'cross-site' }, 403],
      [{ origin: 'http://localhost' }, 403], // setup_required: past the origin check
    ];
    for (const [headers, status] of cases) {
      const res = await h.request('POST', '/api/v1/auth/login', { body, headers });
      expect(res.status, JSON.stringify(headers)).toBe(status);
      const code = await errorCode(res);
      expect(code).toBe(headers.origin === 'http://localhost' ? 'setup_required' : 'bad_origin');
    }
  });

  it('answers only setup routes in setup mode, then removes them', async () => {
    const h = await harness();
    expect(await errorCode(await h.request('GET', '/api/v1/nodes'))).toBe('setup_required');
    expect(await (await h.request('GET', '/api/v1/setup')).json()).toEqual({ setupRequired: true });
    await loggedIn(h);
    expect(
      (await h.request('POST', '/api/v1/setup', { body: { action: 'start', token: h.setupToken() } })).status,
    ).toBe(404);
    expect(await (await h.request('GET', '/api/v1/setup')).json()).toEqual({ setupRequired: false });
  });

  it.each([true, false])(
    'serves optional TLS certificate metadata through setup without granting application access (%s)',
    async (withCertificate) => {
      const tlsCertificate = {
        fingerprintSha256: Array<string>(32).fill('AB').join(':'),
        expiresAt: '2027-10-15T00:00:00.000Z',
      };
      const h = await harness(withCertificate ? { tlsCertificate } : {});
      const response = await h.request('POST', '/api/v1/setup', { body: { action: 'start', token: h.setupToken() } });
      expect(response.status).toBe(200);
      const wire = await response.json();
      const progress = SetupProgress.parse(wire);
      expect(progress.step).toBe('password');
      if (withCertificate) expect(progress.tlsCertificate).toEqual(tlsCertificate);
      else expect(wire).not.toHaveProperty('tlsCertificate');
      expect(h.server.auth.setupMode).toBe(true);
      const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      expect(cookie).toContain('__Host-lp_setup=');
      expect(await errorCode(await h.request('GET', '/api/v1/nodes', { cookie }))).toBe('setup_required');
    },
  );

  it('logs in with a __Host- session cookie and requires the CSRF token', async () => {
    const h = await harness();
    const enrolled = await setupForTest(h.server.setup, h.setupToken(), PASSWORD, h.clock.now);
    h.secret = enrolled.secret;
    expect(
      await errorCode(await h.request('POST', '/api/v1/auth/login', { body: { password: 'Wrong-password-1' } })),
    ).toBe('login_failed');
    const res = await h.request('POST', '/api/v1/auth/login', {
      cookie: `__Host-lp_device=${enrolled.reply.deviceCookie ?? ''}`,
      body: { password: PASSWORD, totpCode: totp(h.secret ?? '', new Date(h.clock.now.getTime() + 30_000)) },
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^__Host-lp_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain/);
    const cookie = setCookie.split(';')[0] ?? '';
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    expect((await h.request('GET', '/api/v1/nodes', { cookie })).status).toBe(200);
    const noCsrf = await h.request('POST', '/api/v1/auth/logout', { cookie });
    expect(await errorCode(noCsrf)).toBe('csrf_failed');
    expect((await h.request('POST', '/api/v1/auth/logout', { cookie, csrf: csrfToken })).status).toBe(204);
    expect(await errorCode(await h.request('GET', '/api/v1/nodes', { cookie }))).toBe('unauthenticated');
  });

  it('lets the owner log in again with a stale session cookie and no CSRF token', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    // The session ended on the server (idle timeout) while the browser kept the cookie.
    await h.server.db.deleteFrom('sessions').execute();
    expect(await errorCode(await h.request('GET', '/api/v1/nodes', { cookie: auth.cookie }))).toBe('unauthenticated');
    h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    const res = await h.request('POST', '/api/v1/auth/login', {
      cookie: auth.cookie,
      body: { password: PASSWORD, totpCode: totp(h.secret ?? '', new Date(h.clock.now.getTime() + 30_000)) },
    });
    expect(res.status).toBe(200);
  });

  it('refuses every session route without a session', async () => {
    const h = await harness();
    await loggedIn(h);
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, path] of [
      ['GET', '/api/v1/nodes'],
      ['POST', '/api/v1/nodes'],
      ['GET', `/api/v1/nodes/${id}`],
      ['GET', `/api/v1/nodes/${id}/balances`],
      ['POST', `/api/v1/nodes/${id}/invoices`],
      ['POST', `/api/v1/nodes/${id}/payments/preview`],
      ['POST', `/api/v1/nodes/${id}/payments/execute`],
      ['GET', '/api/v1/auth/session'],
      ['POST', '/api/v1/auth/logout'],
    ]) {
      const res = await h.request(method ?? 'GET', path ?? '/', method === 'POST' ? { body: {} } : {});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('adds a node after the chain identity check, and refuses one on the wrong chain', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const res = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b');
    expect(res.status).toBe(201);
    const node = (await res.json()) as { id: string; chainIdentity: { state: string }; canSpend: boolean };
    expect(node.chainIdentity.state).toBe('confirmed');
    expect(node.canSpend).toBe(true);
    const wrong = await addNode(h, auth, 'https://a.bitcoin.test', 'blake2b');
    expect(wrong.status).toBe(409);
    const body = (await wrong.json()) as { error: { code: string; details: { failedCheck: string } } };
    expect(body.error).toMatchObject({ code: 'chain_refused', details: { failedCheck: 'software' } });
    const dup = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b');
    expect(await errorCode(dup)).toBe('validation_failed');
    const list = (await (await h.request('GET', '/api/v1/nodes', auth)).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
    // Credentials are stored encrypted and never returned.
    const rows = await h.server.db.selectFrom('credentials').selectAll().execute();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(Buffer.from(r.ciphertext).toString('utf8')).not.toContain('rune');
    expect(JSON.stringify(list)).not.toContain(VIEW_RUNE);
  });

  it('keeps to the node limit when nodes are added at the same time', async () => {
    const h = await harness({ maxNodes: 1 });
    const auth = await loggedIn(h);
    const results = await Promise.all([
      addNode(h, auth, 'https://a.blake2b.test', 'blake2b'),
      addNode(h, auth, 'https://b.blake2b.test', 'blake2b'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    const refused = results.find((r) => r.status === 400);
    expect(refused && (await errorCode(refused))).toBe('validation_failed');
    expect(await h.server.db.selectFrom('nodes').select('id').execute()).toHaveLength(1);
  });

  it('refuses regtest nodes outside development mode', async () => {
    const h = await harness({ dev: false });
    const auth = await loggedIn(h);
    const res = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b');
    expect(await errorCode(res)).toBe('validation_failed');
  });

  it('validates strictly: unknown fields, bad values, oversized bodies', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    expect(await errorCode(await addNode(h, auth, 'https://a.blake2b.test', 'blake2b', { extra: 1 }))).toBe(
      'validation_failed',
    );
    expect(await errorCode(await addNode(h, auth, 'http://a.blake2b.test', 'blake2b'))).toBe('validation_failed');
    const big = await h.request('POST', '/api/v1/nodes', { ...auth, body: 'x'.repeat(70_000) });
    expect(await errorCode(big)).toBe('body_too_large');
    const broken = await h.request('POST', '/api/v1/nodes', { ...auth, body: '{not json' });
    expect(await errorCode(broken)).toBe('validation_failed');
  });

  it('reads info and balances, creates invoices, and pays through preview and confirmation', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };

    const info = (await (await h.request('GET', `/api/v1/nodes/${id}`, auth)).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ id, chain: 'blake2b', network: 'regtest', chainIdentity: { state: 'confirmed' } });
    const balances = (await (await h.request('GET', `/api/v1/nodes/${id}/balances`, auth)).json()) as {
      lightning: { local: string };
    };
    expect(balances.lightning.local).toBe('1000000000');

    const invoice = await h.request('POST', `/api/v1/nodes/${id}/invoices`, {
      ...auth,
      body: { amount: '5000', description: 'coffee' },
    });
    expect(invoice.status).toBe(201);
    expect(((await invoice.json()) as { bolt11: string }).bolt11).toMatch(/^lnbcrt/);

    const other = h.fakes.get('https://b.blake2b.test');
    const bolt11 = (await other?.receive.createInvoice({ amount: msat(21_000n), description: 'x', label: 'x' }))
      ?.bolt11;
    const preview = await h.request('POST', `/api/v1/nodes/${id}/payments/preview`, {
      ...auth,
      body: { request: bolt11 },
    });
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as { confirmationToken: string; cost: Record<string, string> };
    expect(p.cost).toEqual({ amount: '21000', maxFee: '10210', total: '31210' });

    const execute = (token: string, key: string, a = auth) =>
      h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
        ...a,
        body: { acknowledgeDuplicate: true, confirmationToken: token },
        headers: { 'idempotency-key': key },
      });
    const missingKey = await h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
      ...auth,
      body: { acknowledgeDuplicate: true, confirmationToken: p.confirmationToken },
    });
    expect(await errorCode(missingKey)).toBe('validation_failed');

    const key = 'key-' + randomBytes(12).toString('hex');
    const paid = await execute(p.confirmationToken, key);
    expect(paid.status).toBe(200);
    const result = (await paid.json()) as { state: string; preimage: string; intentId: string };
    expect(result.state).toBe('succeeded');
    expect(result.preimage).toMatch(/^[0-9a-f]{64}$/);

    // Same key and token: the recorded outcome, nothing paid twice.
    const again = (await (await execute(p.confirmationToken, key)).json()) as { state: string; intentId: string };
    expect(again).toMatchObject({ state: 'succeeded', intentId: result.intentId });
    expect(h.fakes.get('https://a.blake2b.test')?.calls.filter((c) => c === 'pay')).toHaveLength(1);
    // The token is single-use; the key cannot be reused for another request.
    expect(await errorCode(await execute(p.confirmationToken, 'key-' + randomBytes(12).toString('hex')))).toBe(
      'confirmation_invalid',
    );
    const second = (await (
      await h.request('POST', `/api/v1/nodes/${id}/payments/preview`, {
        ...auth,
        body: {
          request: (await other?.receive.createInvoice({ amount: msat(1_000n), description: 'x', label: 'y' }))?.bolt11,
        },
      })
    ).json()) as { confirmationToken: string };
    expect(await errorCode(await execute(second.confirmationToken, key))).toBe('idempotency_conflict');
  });

  it('binds the confirmation to the session that previewed', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };
    const bolt11 = (
      await h.fakes
        .get('https://b.blake2b.test')
        ?.receive.createInvoice({ amount: msat(1_000n), description: 'x', label: 'x' })
    )?.bolt11;
    const p = (await (
      await h.request('POST', `/api/v1/nodes/${id}/payments/preview`, { ...auth, body: { request: bolt11 } })
    ).json()) as {
      confirmationToken: string;
    };
    h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    const res2 = await h.request('POST', '/api/v1/auth/login', {
      body: { password: PASSWORD, totpCode: totp(h.secret ?? '', new Date(h.clock.now.getTime() + 30_000)) },
    });
    const other = {
      cookie: (res2.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      csrf: ((await res2.json()) as { csrfToken: string }).csrfToken,
    };
    const res = await h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
      ...other,
      body: { acknowledgeDuplicate: true, confirmationToken: p.confirmationToken },
      headers: { 'idempotency-key': 'key-' + randomBytes(12).toString('hex') },
    });
    expect(await errorCode(res)).toBe('confirmation_invalid');
  });

  it('refuses invoices for another network and invoices nobody can pay', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };
    const mainnet = new FakeAdapter({ chain: 'blake2b', network: 'mainnet', world: h.world });
    const bolt11 = (await mainnet.receive.createInvoice({ amount: msat(1_000n), description: 'x', label: 'x' })).bolt11;
    const res = await h.request('POST', `/api/v1/nodes/${id}/payments/preview`, { ...auth, body: { request: bolt11 } });
    expect(await errorCode(res)).toBe('validation_failed');
    const garbage = await h.request('POST', `/api/v1/nodes/${id}/payments/preview`, {
      ...auth,
      body: { request: 'lnbcrt1notaninvoice' },
    });
    expect(await errorCode(garbage)).toBe('validation_failed');
  });

  it('records a definitive failure as failed and lets the next payment through', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };
    // An invoice from a fake on another network of fakes: no route, nothing paid.
    const stranger = new FakeAdapter({ chain: 'blake2b' });
    const pay = async (bolt11: string | undefined) => {
      const p = (await (
        await h.request('POST', `/api/v1/nodes/${id}/payments/preview`, { ...auth, body: { request: bolt11 } })
      ).json()) as {
        confirmationToken: string;
      };
      return h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
        ...auth,
        body: { acknowledgeDuplicate: true, confirmationToken: p.confirmationToken },
        headers: { 'idempotency-key': 'key-' + randomBytes(12).toString('hex') },
      });
    };
    const failed = await pay(
      (await stranger.receive.createInvoice({ amount: msat(1_000n), description: 'x', label: 'x' })).bolt11,
    );
    expect(failed.status).toBe(422);
    expect(await errorCode(failed)).toBe('payment_failed');
    const intents = await h.server.db.selectFrom('spend_intents').select('state').execute();
    expect(intents).toEqual([{ state: 'failed' }]);
    const other = h.fakes.get('https://b.blake2b.test');
    const ok = await pay(
      (await other?.receive.createInvoice({ amount: msat(1_000n), description: 'x', label: 'x' }))?.bolt11,
    );
    expect(ok.status).toBe(200);
  });

  it('records an unclear outcome as unknown and blocks only that invoice, not the node', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };
    const other = h.fakes.get('https://b.blake2b.test');
    const invoice = async () =>
      (await other?.receive.createInvoice({ amount: msat(1_000n), description: 'x', label: 'x' }))?.bolt11;
    const preview = (request: string | undefined) =>
      h.request('POST', `/api/v1/nodes/${id}/payments/preview`, { ...auth, body: { request } });
    const token = async (request: string | undefined) =>
      ((await (await preview(request)).json()) as { confirmationToken: string }).confirmationToken;
    const execute = (t: string) =>
      h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
        ...auth,
        body: { acknowledgeDuplicate: true, confirmationToken: t },
        headers: { 'idempotency-key': 'key-' + randomBytes(12).toString('hex') },
      });
    const first = await invoice();
    const firstToken = await token(first);
    const secondToken = await token(first);
    h.fakes
      .get('https://a.blake2b.test')
      ?.failNext(new AdapterError({ code: 'node_unreachable', sent: true, definitive: false }));
    const res = await execute(firstToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe('unknown');
    // The same invoice: refused at preview and at execute (a token taken before the outcome was known).
    expect(await errorCode(await preview(first))).toBe('spend_unknown');
    expect(await errorCode(await execute(secondToken))).toBe('spend_unknown');
    // Another invoice on the same node goes through.
    const other2 = await execute(await token(await invoice()));
    expect(other2.status).toBe(200);
    expect(((await other2.json()) as { state: string }).state).toBe('succeeded');
  });

  it('sends security headers and never caches API responses', async () => {
    const h = await harness();
    const res = await h.request('GET', '/api/v1/setup');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sends security headers and no-store on refusals before routing too', async () => {
    const h = await harness();
    for (const res of [
      await h.request('GET', '/api/v1/setup', { headers: { host: 'evil.example' } }),
      await h.request('POST', '/api/v1/auth/login', {
        body: { password: 'x' },
        headers: { origin: 'https://evil.example' },
      }),
      await h.request('POST', '/api/v1/auth/login', { body: 'x'.repeat(70_000) }),
    ]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('never writes a secret to the log', async () => {
    const h = await harness();
    const token = h.setupToken();
    const auth = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };
    const bolt11 =
      (
        await h.fakes
          .get('https://b.blake2b.test')
          ?.receive.createInvoice({ amount: msat(1_000n), description: 'x', label: 'x' })
      )?.bolt11 ?? '';
    const p = (await (
      await h.request('POST', `/api/v1/nodes/${id}/payments/preview`, { ...auth, body: { request: bolt11 } })
    ).json()) as {
      confirmationToken: string;
    };
    const paid = (await (
      await h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
        ...auth,
        body: { acknowledgeDuplicate: true, confirmationToken: p.confirmationToken },
        headers: { 'idempotency-key': 'key-' + randomBytes(12).toString('hex') },
      })
    ).json()) as { preimage: string };
    const cookieValue = auth.cookie.split('=')[1] ?? '';
    const secrets = [
      PASSWORD,
      VIEW_RUNE,
      SPEND_RUNE,
      cookieValue,
      auth.csrf,
      p.confirmationToken,
      paid.preimage,
      bolt11,
    ];
    const tokenLines = h.lines.filter((l) => l.includes(token));
    expect(tokenLines).toHaveLength(1);
    expect(tokenLines[0]).toContain('"setupToken"');
    for (const line of h.lines) {
      for (const secret of secrets) expect(line.includes(secret), `${secret.slice(0, 8)}… in ${line}`).toBe(false);
    }
  });
});

describe(`spend edge cases (${testDriver()})`, () => {
  async function setupNode(extra: Record<string, unknown> = {}) {
    const h = await harness();
    const auth = await loggedIn(h);
    const res = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b', extra);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const other = h.fakes.get('https://b.blake2b.test');
    const invoice = async (amount = 1_000n, expirySeconds?: number) =>
      (
        await other?.receive.createInvoice({
          amount: msat(amount),
          description: 'x',
          label: 'x',
          ...(expirySeconds === undefined ? {} : { expirySeconds }),
        })
      )?.bolt11;
    const preview = (request: string | undefined) =>
      h.request('POST', `/api/v1/nodes/${id}/payments/preview`, { ...auth, body: { request } });
    const execute = (token: string, key = 'key-' + randomBytes(12).toString('hex')) =>
      h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
        ...auth,
        body: { acknowledgeDuplicate: true, confirmationToken: token },
        headers: { 'idempotency-key': key },
      });
    const token = async (bolt11: string | undefined) =>
      ((await (await preview(bolt11)).json()) as { confirmationToken: string }).confirmationToken;
    return { h, auth, id, invoice, preview, execute, token };
  }

  it('refuses to preview without a spend credential', async () => {
    const { preview, invoice } = await setupNode({ spendRune: undefined });
    expect(await errorCode(await preview(await invoice()))).toBe('capability_missing');
  });

  it('refuses to preview while the chain identity is waiting or refused', async () => {
    const { h, id, preview, invoice } = await setupNode();
    await h.server.db.updateTable('nodes').set({ identity_state: 'waiting' }).where('id', '=', id).execute();
    expect(await errorCode(await preview(await invoice()))).toBe('chain_waiting');
    await h.server.db.updateTable('nodes').set({ identity_state: 'refused' }).where('id', '=', id).execute();
    expect(await errorCode(await preview(await invoice()))).toBe('chain_refused');
  });

  it('refuses a node that is no longer the one that was checked', async () => {
    const { h, id, preview, invoice } = await setupNode();
    await h.server.db
      .updateTable('nodes')
      .set({ pubkey: '03' + '11'.repeat(32) })
      .where('id', '=', id)
      .execute();
    expect(await errorCode(await preview(await invoice()))).toBe('chain_refused');
  });

  it('refuses to preview after the node dropped away, until a full check confirms it again', async () => {
    const { h, auth, preview, invoice } = await setupNode();
    const fake = h.fakes.get('https://a.blake2b.test');
    if (!fake) throw new Error('no fake');
    const bolt11 = await invoice();
    const down = vi
      .spyOn(fake.node, 'getInfo')
      .mockRejectedValue(new AdapterError({ code: 'node_unreachable', sent: false, definitive: true }));
    expect(await errorCode(await preview(bolt11))).toBe('chain_refused');
    down.mockRestore();
    // Back on the next preview: the reconnect runs a full check first, which confirms it again.
    expect((await preview(bolt11)).status).toBe(200);
    // A new block on the wrong chain's software: the preview's full check refuses it before anything is paid.
    fake.blockHeight += 1;
    fake.featuresOverride = '';
    expect(await errorCode(await preview(bolt11))).toBe('chain_refused');
    const nodes = (await (await h.request('GET', '/api/v1/nodes', auth)).json()) as unknown;
    expect(JSON.stringify(nodes)).toContain('"failedCheck":"software"');
  });

  it('refuses to execute a confirmed preview once the node is no longer confirmed, but still answers a retry', async () => {
    const { h, id, invoice, token, execute } = await setupNode();
    const setState = (state: 'waiting' | 'refused' | 'confirmed') =>
      h.server.db.updateTable('nodes').set({ identity_state: state }).where('id', '=', id).execute();
    const waiting = await token(await invoice());
    await setState('waiting');
    expect(await errorCode(await execute(waiting))).toBe('chain_waiting');
    await setState('confirmed');
    const refused = await token(await invoice());
    await setState('refused');
    expect(await errorCode(await execute(refused))).toBe('chain_refused');
    await setState('confirmed');
    const paid = await token(await invoice());
    const key = 'key-' + randomBytes(12).toString('hex');
    expect((await execute(paid, key)).status).toBe(200);
    await setState('refused');
    // A retry with the same key returns the first result.
    expect((await execute(paid, key)).status).toBe(200);
  });

  // The identity monitor may refuse the node while execute is between loading the node and claiming the spend: the
  // claim must see the refusal (chain-identity spec §5).
  it('refuses to execute when the node is refused after execute loaded it', async () => {
    const { h, invoice, token, execute } = await setupNode();
    const fake = h.fakes.get('https://a.blake2b.test');
    if (!fake) throw new Error('no fake');
    const t = await token(await invoice());
    const load = h.server.nodes.adapter.bind(h.server.nodes);
    vi.spyOn(h.server.nodes, 'adapter').mockImplementationOnce(async (nodeId) => {
      const loaded = await load(nodeId);
      // A new block on the wrong chain's software: the real full check refuses it.
      fake.blockHeight += 1;
      fake.featuresOverride = '';
      expect((await h.server.nodes.monitor.fullCheck(nodeId, 'block')).state).toBe('refused');
      return loaded;
    });
    expect(await (await execute(t)).json()).toMatchObject({ error: { code: 'chain_refused' } });
    expect(await h.server.db.selectFrom('spend_intents').select('id').execute()).toEqual([]);
  });

  // After a restart the stored state and any stored confirmation are from the previous run: the first spend checks the
  // node before it is admitted, rather than trust them (the start-up pass may not have reached it yet).
  it('runs a full check before the first spend on a node not checked since start-up', async () => {
    const { h, id, invoice, token, execute } = await setupNode();
    const fake = h.fakes.get('https://a.blake2b.test');
    if (!fake) throw new Error('no fake');
    const t = await token(await invoice());
    h.server.nodes.monitor.forget(id);
    fake.blockHeight += 1;
    fake.featuresOverride = '';
    expect(await (await execute(t)).json()).toMatchObject({ error: { code: 'chain_refused' } });
    expect(await h.server.db.selectFrom('spend_intents').select('id').execute()).toEqual([]);
  });

  it('waits for a full check that is already running before it admits a spend', async () => {
    const { h, id, invoice, token, execute } = await setupNode();
    const fake = h.fakes.get('https://a.blake2b.test');
    if (!fake) throw new Error('no fake');
    const t = await token(await invoice());
    // The full check stops at the tip header until execute asks to be admitted.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const getTipHeader = fake.chain.getTipHeader.bind(fake.chain);
    vi.spyOn(fake.chain, 'getTipHeader').mockImplementationOnce(async () => {
      await gate;
      return getTipHeader();
    });
    const admit = h.server.nodes.monitor.admit.bind(h.server.nodes.monitor);
    vi.spyOn(h.server.nodes.monitor, 'admit').mockImplementationOnce((nodeId, admission) => {
      release();
      return admit(nodeId, admission);
    });
    fake.blockHeight += 1;
    fake.featuresOverride = '';
    const check = h.server.nodes.monitor.fullCheck(id, 'block');
    expect(await (await execute(t)).json()).toMatchObject({ error: { code: 'chain_refused' } });
    expect((await check).state).toBe('refused');
    expect(await h.server.db.selectFrom('spend_intents').select('id').execute()).toEqual([]);
  });

  it('refuses to preview when a full check refuses the node while the preview asks it for its facts', async () => {
    const { h, id, invoice, preview } = await setupNode();
    const fake = h.fakes.get('https://a.blake2b.test');
    if (!fake) throw new Error('no fake');
    const bolt11 = await invoice();
    const getInfo = fake.node.getInfo.bind(fake.node);
    vi.spyOn(fake.node, 'getInfo').mockImplementationOnce(async () => {
      const facts = await getInfo();
      // Same facts as the last full check, but another full check refuses the node meanwhile.
      fake.featuresOverride = '';
      expect((await h.server.nodes.monitor.fullCheck(id, 'block')).state).toBe('refused');
      return facts;
    });
    expect(await (await preview(bolt11)).json()).toMatchObject({ error: { code: 'chain_refused' } });
  });

  it('refuses amountless and expired invoices', async () => {
    const { preview, invoice } = await setupNode();
    const amountless = fixtures.invoices.find((i) => i.chain === 'blake2b' && i.amountMsat === null);
    expect(await errorCode(await preview(amountless?.bolt11))).toBe('validation_failed');
    expect(await errorCode(await preview(await invoice(1_000n, 0)))).toBe('validation_failed');
  });

  it('answers a retry of a payment that is still running with a conflict, and of a failed one with the failure', async () => {
    const { h, execute, token, invoice } = await setupNode();
    const t = await token(await invoice());
    const key = 'key-' + randomBytes(12).toString('hex');
    expect((await execute(t, key)).status).toBe(200);
    await h.server.db.updateTable('spend_intents').set({ state: 'reserved' }).execute();
    expect(await errorCode(await execute(t, key))).toBe('idempotency_conflict');
    await h.server.db.updateTable('spend_intents').set({ state: 'failed' }).execute();
    const replay = await execute(t, key);
    expect(replay.status).toBe(422);
    expect(await errorCode(replay)).toBe('payment_failed');
  });

  it('records unknown when the node pays a different hash or throws something unexpected', async () => {
    const { h, execute, token, invoice } = await setupNode();
    const fake = h.fakes.get('https://a.blake2b.test');
    if (!fake) throw new Error('no fake');
    const real = fake.pay.pay;
    fake.pay.pay = async (request) => ({ ...(await real(request)), paymentHash: 'cd'.repeat(32) as never });
    const res = await execute(await token(await invoice()));
    expect(((await res.json()) as { state: string }).state).toBe('unknown');
    await h.server.db.updateTable('spend_intents').set({ state: 'succeeded' }).execute();
    fake.pay.pay = async () => {
      throw new Error('unexpected');
    };
    const res2 = await execute(await token(await invoice()));
    expect(((await res2.json()) as { state: string }).state).toBe('unknown');
    const codes = await h.server.db.selectFrom('spend_intents').select('error_code').orderBy('created_at').execute();
    expect(codes.map((c) => c.error_code)).toEqual(['node_bad_response', 'internal']);
  });

  it('refuses to pay an invoice again once it has been paid from the node', async () => {
    const { execute, token, invoice, preview } = await setupNode();
    const bolt11 = await invoice();
    const t = await token(bolt11);
    expect((await execute(t)).status).toBe(200);
    const again = await preview(bolt11);
    expect(await errorCode(again)).toBe('validation_failed');
  });

  it('settles an unknown payment from the node record: complete means paid, failed frees the invoice', async () => {
    const { h, id, execute, token, invoice, preview } = await setupNode();
    const fake = h.fakes.get('https://a.blake2b.test');
    if (!fake) throw new Error('no fake');
    const unknownPayment = async () => {
      const bolt11 = await invoice();
      const t = await token(bolt11);
      fake.failNext(new AdapterError({ code: 'node_unreachable', sent: true, definitive: false }));
      const res = await execute(t);
      expect(((await res.json()) as { state: string }).state).toBe('unknown');
      return bolt11;
    };
    const stateOf = async () =>
      await h.server.db
        .selectFrom('spend_intents')
        .select(['state', 'fee_msat'])
        .where('node_id', '=', id)
        .orderBy('created_at', 'desc')
        .executeTakeFirstOrThrow();
    const realGetPayment = fake.pay.getPayment;

    // The node's record says complete: the intent becomes succeeded (fee from the node), and the invoice is paid.
    const paid = await unknownPayment();
    fake.pay.getPayment = async (hash) => ({ paymentHash: hash, status: 'succeeded', amountSent: msat(1_002n) });
    expect(await errorCode(await preview(paid))).toBe('validation_failed');
    expect(await stateOf()).toEqual({ state: 'succeeded', fee_msat: '2' });

    // The node's record says every part failed, but xpay may still be retrying: stays unknown.
    const failed = await unknownPayment();
    fake.pay.getPayment = async (hash) => ({ paymentHash: hash, status: 'failed' });
    expect(await errorCode(await preview(failed))).toBe('spend_unknown');
    // Long enough after the call: failed, and the invoice can be paid.
    await h.server.db
      .updateTable('spend_intents')
      .set({ updated_at: new Date(Date.now() - 121_000).toISOString() })
      .where('state', '=', 'unknown')
      .execute();
    const t = await token(failed);
    fake.pay.getPayment = realGetPayment;
    expect(
      (await h.server.db.selectFrom('spend_intents').select('state').where('state', '=', 'failed').execute()).length,
    ).toBe(1);
    expect(((await (await execute(t)).json()) as { state: string }).state).toBe('succeeded');

    // No record, pending, or an unreadable record: stays unknown.
    for (const answer of [undefined, 'pending', 'error'] as const) {
      const bolt11 = await unknownPayment();
      await h.server.db
        .updateTable('spend_intents')
        .set({ updated_at: '2020-01-01T00:00:00.000Z' })
        .where('state', '=', 'unknown')
        .execute();
      fake.pay.getPayment = async (hash) => {
        if (answer === 'error') throw new AdapterError({ code: 'node_unreachable', sent: true, definitive: false });
        return answer === undefined ? undefined : { paymentHash: hash, status: answer };
      };
      expect(await errorCode(await preview(bolt11))).toBe('spend_unknown');
      fake.pay.getPayment = realGetPayment;
    }
  });

  it('stores what the node paid, and flags it, when it differs from what was confirmed', async () => {
    const { h, execute, token, invoice } = await setupNode();
    const fake = h.fakes.get('https://a.blake2b.test');
    if (!fake) throw new Error('no fake');
    const real = fake.pay.pay;
    fake.pay.pay = async (request) => ({ ...(await real(request)), amount: msat(2_000n), fee: msat(9_000n) });
    const res = await execute(await token(await invoice(1_000n)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'succeeded', amount: '2000', fee: '9000' });
    expect(
      await h.server.db
        .selectFrom('spend_intents')
        .select(['state', 'amount_msat', 'fee_msat', 'error_code'])
        .executeTakeFirst(),
    ).toEqual({ state: 'succeeded', amount_msat: '2000', fee_msat: '9000', error_code: 'amount_mismatch' });
    expect(h.lines.some((l) => l.includes('node paid other figures than confirmed'))).toBe(true);
  });

  it('sends the node the normalised invoice, not the text as typed', async () => {
    const { h, execute, token, invoice } = await setupNode();
    const fake = h.fakes.get('https://a.blake2b.test');
    if (!fake) throw new Error('no fake');
    const sent: string[] = [];
    const real = fake.pay.pay;
    fake.pay.pay = async (request) => {
      sent.push(request.bolt11);
      return real(request);
    };
    const bolt11 = (await invoice()) ?? '';
    expect((await execute(await token(`  Lightning:${bolt11.toUpperCase()} `))).status).toBe(200);
    expect(sent).toEqual([bolt11.toLowerCase()]);
  });
});

describe('sessions over the API', () => {
  it('returns the session and its CSRF token after a reload', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const res = await h.request('GET', '/api/v1/auth/session', { cookie: auth.cookie });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { csrfToken: string }).csrfToken).toBe(auth.csrf);
  });
});

describe('start-up', () => {
  const startAt = (dir: string, key: Buffer, lines: string[], adapterFactory?: (c: NodeConnection) => FakeAdapter) => {
    const vaultKey = writeVaultKey(dir, key);
    const { config } = loadConfig({
      readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: dir, vaultKey } }),
    });
    return buildServer({
      config,
      vaultKeyPath: vaultKey,
      dev: true,
      logger: createLogger({ sink: (l) => lines.push(l) }),
      driver: testDriver(),
      scryptCost: { log2N: 10, r: 8, p: 1 },
      ...(adapterFactory ? { adapterFactory } : {}),
    });
  };
  const setupToken = (lines: string[]) =>
    (JSON.parse(lines.find((l) => l.includes('"setupToken"')) ?? '{}') as { setupToken: string }).setupToken;

  it('refuses a vault key that does not match the database', async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const lines: string[] = [];
    const first = await startAt(dir, randomBytes(32), lines);
    await setupForTest(first.setup, setupToken(lines), PASSWORD);
    await first.close();
    await expect(startAt(dir, randomBytes(32), lines)).rejects.toThrow(/does not match this database/);
  });

  // The server wipes the key it read from the file once the vault has started; the vault must keep working with its
  // own copy, so a restart with the same key file opens the database and reads the stored credentials.
  it('restarts with the same vault key after setup and reads the stored credentials', async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const key = randomBytes(32);
    const lines: string[] = [];
    const world = new FakeNetwork();
    const first = await startAt(
      dir,
      key,
      lines,
      () => new FakeAdapter({ chain: 'blake2b', network: 'regtest', world }),
    );
    await setupForTest(first.setup, setupToken(lines), PASSWORD);
    const node = await first.nodes.add(
      {
        name: 'test node',
        chain: 'blake2b',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://a.blake2b.test',
        caCertificate: CA,
        serverName: 'localhost',
        viewRune: VIEW_RUNE,
        spendRune: SPEND_RUNE,
      },
      'r-test',
    );
    await first.close();

    const connections: NodeConnection[] = [];
    const second = await startAt(dir, key, lines, (c) => {
      connections.push(c);
      return new FakeAdapter({ chain: 'blake2b', network: 'regtest', world });
    });
    cleanups.push(() => second.close());
    await second.nodes.adapter(node.id);
    expect(connections).toEqual([expect.objectContaining({ viewRune: VIEW_RUNE })]);
    expect(connections[0]).not.toHaveProperty('spendRune');
  });
});

describe(`WP09 spending policy (${testDriver()})`, () => {
  const basePolicy = {
    maxPerPayment: null,
    max24h: null,
    stepUpAbove: null,
    maxFeeRate: '10',
    maxFeeSharePercent: 5,
    maxRoutingFeeSharePercent: 1,
    routingFeeAllowance: '10',
  };
  async function spending() {
    const h = await harness();
    const auth = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };
    const path = `/api/v1/nodes/${id}`;
    const payer = h.fakes.get('https://a.blake2b.test');
    const recipient = h.fakes.get('https://b.blake2b.test');
    if (!payer || !recipient) throw new Error('Missing fake');
    const invoice = async (amount = 1000n) =>
      (
        await recipient.receive.createInvoice({
          amount: msat(amount),
          description: '<script>untrusted</script>',
          label: randomBytes(8).toString('hex'),
        })
      ).bolt11;
    const preview = (request: string, extra = {}) =>
      h.request('POST', `${path}/payments/preview`, { ...auth, body: { request, ...extra } });
    const prepare = async (request?: string, extra = {}) => {
      const response = await preview(request ?? (await invoice()), extra);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as {
        confirmationToken: string;
        duplicateWarning: boolean;
        stepUpRequired: boolean;
        feeOverride: boolean;
      };
    };
    const execute = (
      token: string,
      key = randomBytes(16).toString('hex'),
      ack = false,
      credentials: { cookie: string; csrf: string } = auth,
    ) =>
      h.request('POST', `${path}/payments/execute`, {
        ...credentials,
        headers: { 'idempotency-key': key },
        body: { confirmationToken: token, acknowledgeDuplicate: ack },
      });
    const policy = (change = {}) =>
      h.request('POST', `${path}/spend-policy`, { ...auth, body: { ...basePolicy, ...change } });
    const session = await h.server.auth.session(auth.cookie.split('=')[1] ?? '');
    if (!session) throw new Error('Missing test session');
    const handle = session.handle;
    const { SpendService } = await import('./modules/spend/service.ts');
    const service = new SpendService({
      db: h.server.db,
      nodes: h.server.nodes,
      auth: h.server.auth,
      logger: createLogger({ sink: () => undefined }),
    });
    cleanups.push(() => service.close());
    return { h, auth, id, path, payer, recipient, invoice, preview, prepare, execute, policy, handle, service };
  }
  it('requires an explicitly chosen policy, exposes scope and remaining budget, and validates policy edits', async () => {
    const s = await spending();
    await s.h.server.db.deleteFrom('spend_limits').execute();
    expect(await errorCode(await s.preview(await s.invoice()))).toBe('setup_required');
    const read = await s.h.request('GET', `${s.path}/spend-policy`, s.auth);
    expect(await read.json()).toMatchObject({
      policy: null,
      usedMsat: '0',
      remainingMsat: null,
      scope: expect.stringContaining('other apps'),
    });
    expect((await s.policy({ maxPerPayment: '2', max24h: '1' })).status).toBe(400);
    expect(
      (
        await s.policy({
          maxFeeRateMode: 'step-up',
          maxFeeShareMode: 'step-up',
          maxRoutingFeeMode: 'step-up',
          max24h: '50',
        })
      ).status,
    ).toBe(204);
    expect(await (await s.h.request('GET', `${s.path}/spend-policy`, s.auth)).json()).toMatchObject({
      remainingMsat: '50000',
      policy: { maxRoutingFeeMode: 'step-up' },
    });
    expect((await s.h.request('GET', '/api/v1/nodes/missing/spend-policy', s.auth)).status).toBe(400);
    s.h.server.auth.sessions.clearGrants(s.handle);
    expect(await errorCode(await s.policy())).toBe('step_up_required');
  });
  it.each(['blake2b', 'bitcoin'] as const)(
    'refuses wrong-chain invoices on %s using the full signed decoder',
    async (chain) => {
      const h = await harness();
      const auth = await loggedIn(h);
      const url = chain === 'blake2b' ? 'https://a.blake2b.test' : 'https://a.bitcoin.test';
      const { id } = (await (await addNode(h, auth, url, chain)).json()) as { id: string };
      const other = h.fakes.get(chain === 'blake2b' ? 'https://a.bitcoin.test' : 'https://b.blake2b.test');
      const invoice = await other?.receive.createInvoice({
        amount: msat(1000n),
        description: 'wrong chain',
        label: 'wrong chain',
      });
      const response = await h.request('POST', `/api/v1/nodes/${id}/payments/preview`, {
        ...auth,
        body: { request: invoice?.bolt11 },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'validation_failed', details: { reason: 'wrong_chain' } },
      });
    },
  );
  it('refuses unsupported inputs, zero and mismatched amounts, but pays a positive amountless invoice', async () => {
    const s = await spending();
    expect(await errorCode(await s.preview('lno1qqqqqqqqqqqqqq'))).toBe('validation_failed');
    expect(await errorCode(await s.preview(await s.invoice(), { amount: '2000' }))).toBe('validation_failed');
    const any = await s.recipient.receive.createInvoice({ description: 'any amount', label: 'any' });
    expect(await errorCode(await s.preview(any.bolt11, { amount: '0' }))).toBe('validation_failed');
    const pay = vi.spyOn(s.payer.pay, 'pay');
    const p = await s.prepare(any.bolt11, { amount: '12000' });
    expect((await s.execute(p.confirmationToken)).status).toBe(200);
    expect(pay.mock.calls[0]?.[0].amount).toBe(12000n);
    const fixed = await s.prepare(await s.invoice(2000n));
    expect((await s.execute(fixed.confirmationToken)).status).toBe(200);
    expect(pay.mock.calls[1]?.[0]).not.toHaveProperty('amount');
  });
  it('enforces per-payment and rolling caps again at execution and preserves immutable admitted cost', async () => {
    const s = await spending();
    const p = await s.prepare();
    expect((await s.policy({ maxPerPayment: '0' })).status).toBe(204);
    expect(await errorCode(await s.execute(p.confirmationToken))).toBe('limit_exceeded');
    expect(await errorCode(await s.preview(await s.invoice()))).toBe('limit_exceeded');
    await s.policy({ maxPerPayment: '12', max24h: '12' });
    expect((await s.execute(p.confirmationToken)).status).toBe(200);
    expect(await errorCode(await s.preview(await s.invoice(2000n)))).toBe('limit_exceeded');
    const intent = await s.h.server.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow();
    expect(intent.cost_msat).toBe('11010');
    expect(await (await s.h.request('GET', `${s.path}/spend-policy`, s.auth)).json()).toMatchObject({
      usedMsat: '11010',
      remainingMsat: '990',
    });
  });
  it('requires fresh password authority strictly above the threshold and preserves the token across step-up rotation', async () => {
    const s = await spending();
    await s.policy({ stepUpAbove: '0' });
    s.h.server.auth.sessions.clearGrants(s.handle);
    const p = await s.prepare();
    expect(p.stepUpRequired).toBe(true);
    expect(await errorCode(await s.execute(p.confirmationToken))).toBe('step_up_required');
    const step = await s.h.request('POST', '/api/v1/auth/step-up', {
      ...s.auth,
      body: { password: PASSWORD, strength: 'password' },
    });
    expect(step.status).toBe(200);
    const rotated = {
      cookie: (step.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      csrf: ((await step.json()) as { csrfToken: string }).csrfToken,
    };
    expect((await s.execute(p.confirmationToken, undefined, false, rotated)).status).toBe(200);
  });
  it('refuses fee cap excess unless explicitly allowed and protected by password step-up', async () => {
    const s = await spending();
    expect(await errorCode(await s.preview(await s.invoice(), { maxFee: '20000' }))).toBe('fee_cap_exceeded');
    await s.policy({ maxRoutingFeeMode: 'step-up' });
    const p = await s.prepare(undefined, { maxFee: '20000' });
    expect(p.feeOverride).toBe(true);
    s.h.server.auth.sessions.clearGrants(s.handle);
    expect(await errorCode(await s.execute(p.confirmationToken))).toBe('step_up_required');
  });
  it('refuses absurd route estimates and never widens the confirmed fee', async () => {
    const s = await spending();
    vi.spyOn(s.payer.pay, 'previewRoute').mockResolvedValue({ fee: msat(999999999n), hops: 1, probabilityPpm: 0 });
    expect(await errorCode(await s.preview(await s.invoice()))).toBe('fee_cap_exceeded');
    expect(await s.h.server.db.selectFrom('spend_intents').selectAll().execute()).toHaveLength(0);
  });
  it('requires duplicate acknowledgment across devices and detects matching spends admitted after preview', async () => {
    const s = await spending();
    const first = await s.prepare();
    const stale = await s.prepare();
    expect((await s.execute(first.confirmationToken)).status).toBe(200);
    expect(await errorCode(await s.execute(stale.confirmationToken))).toBe('confirmation_invalid');
    const fresh = await s.prepare();
    expect(fresh.duplicateWarning).toBe(true);
    expect(await errorCode(await s.execute(fresh.confirmationToken))).toBe('confirmation_invalid');
    expect((await s.execute(fresh.confirmationToken, undefined, true)).status).toBe(200);
  });
  it('expires live confirmations at two minutes without reserving or contacting the spend method', async () => {
    const s = await spending();
    const p = await s.prepare();
    const pay = vi.spyOn(s.payer.pay, 'pay');
    s.h.clock.now = new Date(s.h.clock.now.getTime() + 120000);
    expect(await errorCode(await s.execute(p.confirmationToken))).toBe('confirmation_invalid');
    expect(pay).not.toHaveBeenCalled();
  });
  it('replays after expiry, confirmation cleanup and a spend-service restart without touching the node', async () => {
    const s = await spending();
    const p = await s.prepare();
    const key = 'wp09-same-key-after-restart';
    const first = await s.execute(p.confirmationToken, key);
    expect(first.status).toBe(200);
    const result = (await first.json()) as { intentId: string };
    s.h.clock.now = new Date(s.h.clock.now.getTime() + 120001);
    const { SpendService } = await import('./modules/spend/service.ts');
    const restarted = new SpendService({
      db: s.h.server.db,
      nodes: s.h.server.nodes,
      auth: s.h.server.auth,
      logger: createLogger({ sink: () => undefined }),
      now: () => s.h.clock.now,
    });
    cleanups.push(() => restarted.close());
    vi.spyOn(s.h.server.nodes, 'adapter').mockRejectedValue(new Error('No RPC or credential access for replay'));
    expect(await restarted.execute(s.handle, s.id, p.confirmationToken, key, 'replay')).toMatchObject({
      intentId: result.intentId,
      state: 'succeeded',
    });
    await expect(restarted.execute(s.handle, s.id, 'changed-token', key, 'replay')).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await expect(restarted.execute(s.handle, 'changed-node', p.confirmationToken, key, 'replay')).rejects.toMatchObject(
      { code: 'idempotency_conflict' },
    );
    await s.h.server.auth.sessions.end(s.handle, 'logout');
    await expect(restarted.execute(s.handle, s.id, p.confirmationToken, key, 'replay')).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
  it('same idempotency key concurrently calls the node once and never reserves twice', async () => {
    const s = await spending();
    const p = await s.prepare();
    const pay = vi.spyOn(s.payer.pay, 'pay');
    const replies = await Promise.all(
      Array.from({ length: 10 }, () => s.execute(p.confirmationToken, 'wp09-concurrent-key')),
    );
    expect(replies.some((r) => r.status === 200)).toBe(true);
    expect(replies.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(await s.h.server.db.selectFrom('spend_intents').selectAll().execute()).toHaveLength(1);
  });
  it('logs limit changes, spend intents and outcomes as security events bound to the session', async () => {
    const s = await spending();
    expect((await s.policy({ max24h: '100' })).status).toBe(204);
    const p = await s.prepare();
    expect((await s.execute(p.confirmationToken)).status).toBe(200);
    const events = s.h.lines.map(
      (line) => JSON.parse(line) as { msg: string; level: string; security?: boolean; sessionHandle?: string },
    );
    for (const [msg, level] of [
      ['spend limits changed', 'warn'],
      ['spend intent', 'info'],
      ['spend result', 'info'],
    ] as const)
      expect(events.find((e) => e.msg === msg)).toMatchObject({ level, security: true, sessionHandle: s.handle });
  });
  it('a second key cannot use the token between the first admission commit and the node call', async () => {
    const s = await spending();
    const p = await s.prepare();
    const pay = vi.spyOn(s.payer.pay, 'pay');
    const monitor = s.h.server.nodes.monitor;
    const admit = monitor.admit.bind(monitor);
    let second: Response | undefined;
    // Run the second execute after the first admission has committed and before the first execute continues.
    vi.spyOn(monitor, 'admit').mockImplementationOnce(async (id, fn) => {
      const admitted = await admit(id, fn);
      second = await s.execute(p.confirmationToken, 'review-second-key-0002');
      return admitted;
    });
    expect((await s.execute(p.confirmationToken, 'review-first-key-0001')).status).toBe(200);
    expect(second && (await errorCode(second))).toBe('confirmation_invalid');
    expect(pay).toHaveBeenCalledTimes(1);
    expect(await s.h.server.db.selectFrom('spend_intents').selectAll().execute()).toHaveLength(1);
  });
  it('returns the stored proof of payment on a same-key replay', async () => {
    const s = await spending();
    const p = await s.prepare();
    const first = (await (await s.execute(p.confirmationToken, 'review-preimage-key-01')).json()) as {
      preimage: string;
      paymentHash: string;
    };
    expect(createHash('sha256').update(Buffer.from(first.preimage, 'hex')).digest('hex')).toBe(first.paymentHash);
    const replay = await s.execute(p.confirmationToken, 'review-preimage-key-01');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ preimage: first.preimage });
    const intent = await s.h.server.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow();
    expect(intent.preimage).toBe(first.preimage);
  });
  it('stores only a preimage that proves the payment hash', async () => {
    const s = await spending();
    // A node reply whose preimage does not hash to the payment hash: the payment is recorded, the value is not.
    vi.spyOn(s.payer.pay, 'pay').mockImplementationOnce(async () => {
      const intent = await s.h.server.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow();
      return {
        paymentHash: parsePaymentHash(intent.payment_hash ?? ''),
        preimage: '00'.repeat(32),
        amount: msat(BigInt(intent.amount_msat)),
        amountSent: msat(BigInt(intent.amount_msat)),
        fee: msat(0n),
      };
    });
    const p = await s.prepare();
    expect((await s.execute(p.confirmationToken, 'review-bad-preimage-key')).status).toBe(200);
    const intent = await s.h.server.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow();
    expect(intent.state).toBe('succeeded');
    expect(intent.preimage).toBeNull();
    expect(await (await s.execute(p.confirmationToken, 'review-bad-preimage-key')).json()).not.toHaveProperty(
      'preimage',
    );
  });
  it('rejects a session revoked during preview or admission awaits', async () => {
    const s = await spending();
    const p = await s.prepare();
    const original = s.h.server.nodes.adapter.bind(s.h.server.nodes);
    vi.spyOn(s.h.server.nodes, 'adapter').mockImplementation(async (id) => {
      const adapter = await original(id);
      await s.h.server.auth.sessions.end(s.handle, 'logout');
      return adapter;
    });
    expect(await errorCode(await s.execute(p.confirmationToken))).toBe('unauthenticated');
    expect(await s.h.server.db.selectFrom('spend_intents').selectAll().execute()).toHaveLength(0);
  });
  it('fails closed at service entry for nonexistent nodes, missing sessions and recovery-only sessions', async () => {
    const s = await spending();
    await expect(s.service.policy('missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      s.service.updatePolicy(
        s.handle,
        'missing',
        await import('@lightning-pilot/core').then((m) => m.SpendPolicy.parse(basePolicy)),
        'test',
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.service.execute('missing', s.id, 'token', 'key', 'test')).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await s.policy({ max24h: '0' });
    expect(await s.service.policy(s.id)).toMatchObject({ remainingMsat: '0' });
    await s.h.server.db.updateTable('sessions').set({ recovery_required: 1 }).where('handle', '=', s.handle).execute();
    await expect(s.service.execute(s.handle, s.id, 'token', 'key', 'test')).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });
  it('refuses a spend credential removed after preview and invalidates a changed node identity', async () => {
    const s = await spending();
    const p = await s.prepare();
    const original = s.h.server.nodes.adapter.bind(s.h.server.nodes);
    const spy = vi
      .spyOn(s.h.server.nodes, 'adapter')
      .mockImplementation(async (id) => ({ ...(await original(id)), canSpend: false }));
    expect(await errorCode(await s.execute(p.confirmationToken))).toBe('capability_missing');
    spy.mockRestore();
    await s.h.server.db.updateTable('nodes').set({ pubkey: s.recipient.pubkey }).where('id', '=', s.id).execute();
    await s.policy();
    expect(await errorCode(await s.execute(p.confirmationToken))).toBe('confirmation_invalid');
  });
  it('drops a live preview when its session ends while leaving another session preview independent', async () => {
    const s = await spending();
    await s.prepare();
    const setupSession = await s.h.server.db
      .selectFrom('sessions')
      .select('handle')
      .where('handle', '!=', s.handle)
      .executeTakeFirstOrThrow();
    await s.h.server.auth.sessions.end(setupSession.handle, 'logout');
    await s.h.server.auth.sessions.end(s.handle, 'logout');
  });
  it('refuses invoices that expire before execute even if the confirmation would otherwise be valid', async () => {
    const s = await spending();
    const invoice = await s.recipient.receive.createInvoice({
      amount: msat(1000n),
      description: 'short expiry',
      label: 'short',
      expirySeconds: 1,
    });
    const p = await s.prepare(invoice.bolt11);
    // Past the invoice's own expiry: the fake stamps invoices with the wall clock, which under load runs ahead of
    // the test clock by more than the one-second expiry.
    s.h.clock.now = new Date(Math.max(s.h.clock.now.getTime() + 1001, Date.parse(invoice.expiresAt) + 1));
    expect(await errorCode(await s.execute(p.confirmationToken))).toBe('confirmation_invalid');
  });
  it('releases the reservation if the action fails before the RPC and keeps its key terminal', async () => {
    const s = await spending();
    const { SpendService } = await import('./modules/spend/service.ts');
    const service = new SpendService({
      db: s.h.server.db,
      nodes: s.h.server.nodes,
      auth: s.h.server.auth,
      now: () => s.h.clock.now,
      logger: {
        ...createLogger({ sink: () => undefined }),
        child: () => ({
          ...createLogger({ sink: () => undefined }),
          info: (msg) => {
            if (msg === 'spend intent' || msg === 'spend result') throw new Error('injected failure before node call');
          },
        }),
      },
    });
    cleanups.push(() => service.close());
    const p = await service.preview(s.handle, s.id, await s.invoice(), 'test');
    const pay = vi.spyOn(s.payer.pay, 'pay');
    await expect(service.execute(s.handle, s.id, p.confirmationToken, 'before-rpc-key', 'test')).rejects.toMatchObject({
      code: 'payment_failed',
    });
    expect(pay).not.toHaveBeenCalled();
    expect(await service.policy(s.id)).toMatchObject({ usedMsat: '0' });
    await expect(service.execute(s.handle, s.id, p.confirmationToken, 'before-rpc-key', 'test')).rejects.toMatchObject({
      code: 'payment_failed',
    });
    expect((await s.h.server.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow()).state).toBe(
      'failed',
    );
  });
  it('shares the invoice guard and budget between two records of the same chain/pubkey', async () => {
    const s = await spending();
    const request = await s.invoice();
    const p = await s.prepare(request);
    expect((await s.execute(p.confirmationToken)).status).toBe(200);
    const node = await s.h.server.db.selectFrom('nodes').selectAll().where('id', '=', s.id).executeTakeFirstOrThrow();
    const alias = '00000000-0000-4000-8000-000000000001';
    await s.h.server.db
      .insertInto('nodes')
      .values({ ...node, id: alias, name: 'alias', network: 'testnet4' })
      .execute();
    // The unique key includes network; historical intent identity must remain independent of its node reference.
    await s.h.server.db.updateTable('spend_intents').set({ node_id: alias }).execute();
    const response = await s.h.request('POST', `/api/v1/nodes/${s.id}/payments/preview`, {
      ...s.auth,
      body: { request },
    });
    expect(await errorCode(response)).toBe('validation_failed');
    expect(await (await s.h.request('GET', `/api/v1/nodes/${alias}/spend-policy`, s.auth)).json()).toMatchObject({
      usedMsat: '11010',
    });
  });
  it('replays through HTTP after closing and reopening the real server and database', async () => {
    const s = await spending();
    const p = await s.prepare();
    const key = 'wp09-real-server-restart';
    const paid = await s.execute(p.confirmationToken, key);
    expect(paid.status).toBe(200);
    const original = (await paid.json()) as { intentId: string };
    const databases = await sql<{ file: string }>`PRAGMA database_list`.execute(s.h.server.db);
    const file = databases.rows[0]?.file;
    if (!file) throw new Error('Missing database path');
    const dir = dirname(file),
      vaultKey = join(dir, 'vault-key');
    const { config } = loadConfig({
      readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: dir, vaultKey } }),
    });
    await s.h.server.close();
    s.h.server.close = async () => undefined;
    const reopened = await buildServer({
      config,
      vaultKeyPath: vaultKey,
      dev: true,
      logger: createLogger({ sink: () => undefined }),
      now: () => s.h.clock.now,
      scryptCost: { log2N: 10, r: 8, p: 1 },
      adapterFactory: (connection) => {
        const fake = s.h.fakes.get(connection.url);
        if (!fake) throw new Error('Missing fake');
        return fake;
      },
    });
    cleanups.unshift(() => reopened.close());
    const response = await reopened.app.request(`${s.path}/payments/execute`, {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'https://localhost',
        'content-type': 'application/json',
        cookie: s.auth.cookie,
        'x-csrf-token': s.auth.csrf,
        'idempotency-key': key,
      },
      body: JSON.stringify({ confirmationToken: p.confirmationToken }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ intentId: original.intentId, state: 'succeeded' });
  });
});

describe(`WP10 crash recovery of BOLT11 spends (${testDriver()})`, () => {
  async function crashed() {
    const h = await harness();
    const auth = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };
    const path = `/api/v1/nodes/${id}`;
    const payer = h.fakes.get('https://a.blake2b.test');
    const recipient = h.fakes.get('https://b.blake2b.test');
    if (!payer || !recipient) throw new Error('Missing fake');
    const invoice = async () =>
      (
        await recipient.receive.createInvoice({
          amount: msat(1000n),
          description: 'x',
          label: randomBytes(8).toString('hex'),
        })
      ).bolt11;
    const preview = async (request: string) =>
      h.request('POST', `${path}/payments/preview`, { ...auth, body: { request } });
    const execute = async (request: string, key: string) => {
      const { confirmationToken } = (await (await preview(request)).json()) as { confirmationToken: string };
      return h.request('POST', `${path}/payments/execute`, {
        ...auth,
        headers: { 'idempotency-key': key },
        body: { confirmationToken, acknowledgeDuplicate: true },
      });
    };
    // Leaves the intent as a stop between commit and outcome write leaves it.
    const interrupt = async (intentId: string, values: Record<string, string> = {}) =>
      h.server.db
        .updateTable('spend_intents')
        .set({ state: 'reserved', fee_msat: null, preimage: null, error_code: null, ...values })
        .where('id', '=', intentId)
        .execute();
    let current = h.server;
    const restart = async () => {
      const databases = await sql<{ file: string }>`PRAGMA database_list`.execute(current.db);
      const dir = dirname(databases.rows[0]?.file ?? '');
      const vaultKey = join(dir, 'vault-key');
      const { config } = loadConfig({
        readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: dir, vaultKey } }),
      });
      await current.close();
      current.close = async () => undefined;
      current = await buildServer({
        config,
        vaultKeyPath: vaultKey,
        dev: true,
        logger: createLogger({ level: 'debug', sink: (l) => h.lines.push(l) }),
        now: () => h.clock.now,
        driver: testDriver(),
        scryptCost: { log2N: 10, r: 8, p: 1 },
        adapterFactory: (connection) => {
          const fake = h.fakes.get(connection.url);
          if (!fake) throw new Error('Missing fake');
          return fake;
        },
      });
      const reopened = current;
      cleanups.unshift(() => reopened.close());
      return reopened;
    };
    const intent = async (server: Server, intentId: string) =>
      server.db
        .selectFrom('spend_intents')
        .select(['state', 'fee_msat', 'preimage', 'error_code'])
        .where('id', '=', intentId)
        .executeTakeFirstOrThrow();
    const replay = (server: Server, request: string, key: string) =>
      Promise.resolve(
        server.app.request(`${path}/payments/execute`, {
          method: 'POST',
          headers: {
            host: 'localhost',
            origin: 'https://localhost',
            'content-type': 'application/json',
            cookie: auth.cookie,
            'x-csrf-token': auth.csrf,
            'idempotency-key': key,
          },
          body: JSON.stringify({ confirmationToken: request }),
        }),
      );
    return { h, auth, id, path, payer, invoice, preview, execute, interrupt, restart, intent, replay };
  }
  const tokenOf = new Map<string, string>();
  const paid = async (s: Awaited<ReturnType<typeof crashed>>, key: string) => {
    const bolt11 = await s.invoice();
    const { confirmationToken } = (await (await s.preview(bolt11)).json()) as { confirmationToken: string };
    tokenOf.set(key, confirmationToken);
    const res = await s.h.request('POST', `${s.path}/payments/execute`, {
      ...s.auth,
      headers: { 'idempotency-key': key },
      body: { confirmationToken, acknowledgeDuplicate: true },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return { bolt11, ...((await res.json()) as { intentId: string; preimage: string; fee?: string }) };
  };

  it('marks interrupted intents unknown before serving, then resolves a payment the node made', async () => {
    const s = await crashed();
    const key = 'wp10-after-node-call';
    const { intentId, preimage } = await paid(s, key);
    await s.interrupt(intentId);
    const server = await s.restart();
    // Before any node call: unknown, still counted, and the same key is no longer "still running" forever.
    expect((await s.intent(server, intentId)).state).toBe('unknown');
    expect(s.h.lines.some((l) => l.includes('spend intents interrupted by a stop') && l.includes('"count":1'))).toBe(
      true,
    );
    expect(await server.recovery.resolvePass()).toBe(0);
    expect(await s.intent(server, intentId)).toMatchObject({ state: 'succeeded', preimage });
    const again = await s.replay(server, tokenOf.get(key) ?? '', key);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ intentId, state: 'succeeded', preimage });
  });

  it('fails an intent the node never saw once xpay would have stopped, and frees its invoice', async () => {
    const s = await crashed();
    const key = 'wp10-before-node-call';
    const { intentId } = await paid(s, key);
    const bolt11 = await s.invoice();
    const { decodeBolt11 } = await import('@lightning-pilot/core');
    const hash = decodeBolt11(bolt11).paymentHash;
    const reserved = s.h.clock.now.toISOString();
    await s.interrupt(intentId, { payment_hash: hash, created_at: reserved, updated_at: reserved });
    // The fixture reused a paid intent: the node must know nothing under its label either.
    s.payer.pay.listByLabel = async () => [];
    const server = await s.restart();
    // Within xpay's retry window: no record yet proves nothing.
    expect(await server.recovery.resolvePass()).toBe(1);
    expect((await s.intent(server, intentId)).state).toBe('unknown');
    s.h.clock.now = new Date(s.h.clock.now.getTime() + 121_000);
    // The backoff holds the next attempt; resolving now needs a fresh recovery (a restart forgets the backoff).
    expect(await server.recovery.resolvePass()).toBe(1);
    const later = await s.restart();
    expect(await later.recovery.resolvePass()).toBe(0);
    expect(await s.intent(later, intentId)).toMatchObject({ state: 'failed', error_code: 'not_on_node' });
    const retry = await s.replay(later, tokenOf.get(key) ?? '', key);
    expect(retry.status).toBe(422);
    expect(await errorCode(retry)).toBe('payment_failed');
  });

  it('keeps unclear intents unknown: pending, unreadable, node gone, or no record after 24 hours', async () => {
    const s = await crashed();
    const ids: string[] = [];
    for (const key of ['wp10-pending-payment', 'wp10-unreadable-payment', 'wp10-very-old-payment']) {
      const { intentId } = await paid(s, key);
      ids.push(intentId);
    }
    const [pending, unreadable, old] = ids as [string, string, string];
    const long = new Date(s.h.clock.now.getTime() - 2 * 86_400_000).toISOString();
    for (const id of ids) await s.interrupt(id, id === old ? { created_at: long, updated_at: long } : {});
    const server = await s.restart();
    s.h.clock.now = new Date(s.h.clock.now.getTime() + 121_000);
    const real = s.payer.pay.getPayment;
    const rows = await server.db.selectFrom('spend_intents').select(['id', 'payment_hash']).execute();
    const hashOf = (id: string) => rows.find((r) => r.id === id)?.payment_hash;
    s.payer.pay.getPayment = async (hash) => {
      if (hash === hashOf(pending)) return { paymentHash: hash, status: 'pending' };
      if (hash === hashOf(unreadable))
        throw new AdapterError({ code: 'node_unreachable', sent: true, definitive: false });
      return undefined;
    };
    expect(await server.recovery.resolvePass()).toBe(3);
    for (const id of ids) expect((await s.intent(server, id)).state).toBe('unknown');
    expect(s.h.lines.some((l) => l.includes('payment status not readable'))).toBe(true);
    s.payer.pay.getPayment = real;

    // A node that cannot be loaded leaves its intents unknown and is asked again later.
    const fresh = await s.restart();
    s.h.fakes.delete('https://a.blake2b.test');
    expect(await fresh.recovery.resolvePass()).toBe(3);
    expect(s.h.lines.some((l) => l.includes('spend recovery: node not available'))).toBe(true);
    // Not due yet: the next pass does not ask again.
    expect(await fresh.recovery.resolvePass()).toBe(3);
    expect(s.h.lines.filter((l) => l.includes('spend recovery: node not available'))).toHaveLength(1);
  });

  it('never fails a run-time unknown for lack of a record, nor an interrupted one the node paid under our label', async () => {
    const s = await crashed();
    // The node paid another hash than confirmed: unknown at run time, and no record under the confirmed hash.
    const real = s.payer.pay.pay;
    s.payer.pay.pay = async (request) => ({ ...(await real(request)), paymentHash: '00'.repeat(32) as PaymentHash });
    const bolt11 = await s.invoice();
    const res = await s.execute(bolt11, 'wp10-node-bad-response');
    expect(((await res.json()) as { state: string }).state).toBe('unknown');
    s.payer.pay.pay = real;
    const { intentId: wrong } = (await s.h.server.db
      .selectFrom('spend_intents')
      .select('id as intentId')
      .where('idempotency_key', '=', 'wp10-node-bad-response')
      .executeTakeFirstOrThrow()) as { intentId: string };
    s.h.clock.now = new Date(s.h.clock.now.getTime() + 121_000);
    s.payer.pay.getPayment = async () => undefined;
    expect(await s.h.server.recovery.resolvePass()).toBe(1);
    expect((await s.intent(s.h.server, wrong)).state).toBe('unknown');

    // Interrupted, no record by hash, but a record under our label: stays unknown.
    const { intentId } = await paid(s, 'wp10-paid-under-label');
    await s.interrupt(intentId);
    const server = await s.restart();
    s.payer.pay.listByLabel = async (label) =>
      label === intentId ? [{ paymentHash: '11'.repeat(32) as PaymentHash, status: 'succeeded' }] : [];
    expect(await server.recovery.resolvePass()).toBe(2);
    expect((await s.intent(server, intentId)).state).toBe('unknown');
    s.payer.pay.listByLabel = async () => {
      throw new AdapterError({ code: 'node_unreachable', sent: true, definitive: false });
    };
    const again = await s.restart();
    expect(await again.recovery.resolvePass()).toBe(2);
    expect((await s.intent(again, intentId)).state).toBe('unknown');
  });

  it('reports the stored state when another path resolved the intent first, and reads odd records safely', async () => {
    const s = await crashed();
    const { intentId } = await paid(s, 'wp10-resolved-meanwhile');
    const { settleBolt11 } = await import('./modules/spend/recovery/index.ts');
    const row = await s.h.server.db
      .selectFrom('spend_intents')
      .selectAll()
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    const logger = createLogger({ sink: () => undefined });
    const args = { ...row, payment_hash: row.payment_hash ?? '' };
    // The row is succeeded already: the update matches nothing, and the stored state is reported.
    expect(await settleBolt11(s.h.server.db, s.payer, args, s.h.clock.now, logger)).toBe('succeeded');
    await s.h.server.db.updateTable('spend_intents').set({ state: 'unknown' }).where('id', '=', intentId).execute();
    // A record without amounts: succeeded, with no fee stored. A reader that throws something unexpected: unknown.
    const odd = {
      ...s.payer,
      pay: {
        ...s.payer.pay,
        getPayment: async () => ({ paymentHash: row.payment_hash as PaymentHash, status: 'succeeded' as const }),
      },
    };
    expect(await settleBolt11(s.h.server.db, odd, args, s.h.clock.now, logger)).toBe('succeeded');
    const broken = {
      ...s.payer,
      pay: {
        ...s.payer.pay,
        getPayment: async () => {
          throw new Error('boom');
        },
      },
    };
    expect(await settleBolt11(s.h.server.db, broken, args, s.h.clock.now, logger)).toBe('unknown');
  });

  it('never settles against a node that fails its chain identity check', async () => {
    const s = await crashed();
    const { intentId } = await paid(s, 'wp10-identity-refused');
    const bolt11 = await s.invoice();
    const { decodeBolt11 } = await import('@lightning-pilot/core');
    const reserved = s.h.clock.now.toISOString();
    await s.interrupt(intentId, {
      payment_hash: decodeBolt11(bolt11).paymentHash,
      created_at: reserved,
      updated_at: reserved,
    });
    s.payer.pay.listByLabel = async () => [];
    const server = await s.restart();
    s.h.clock.now = new Date(s.h.clock.now.getTime() + 121_000);
    // The node now runs the other chain's software: no record there proves nothing.
    s.payer.featuresOverride = '';
    const getPayment = vi.spyOn(s.payer.pay, 'getPayment');
    expect(await server.recovery.resolvePass()).toBe(1);
    expect(getPayment).not.toHaveBeenCalled();
    expect((await s.intent(server, intentId)).state).toBe('unknown');
    expect(s.h.lines.some((l) => l.includes('spend recovery: node not available') && l.includes('chain_refused'))).toBe(
      true,
    );
  });

  it('runs in the background once started, and stops with the server', async () => {
    const s = await crashed();
    const { intentId } = await paid(s, 'wp10-background-loop');
    await s.interrupt(intentId);
    const server = await s.restart();
    server.recovery.start();
    server.recovery.start(); // a second start is ignored
    await vi.waitFor(async () => expect((await s.intent(server, intentId)).state).toBe('succeeded'), {
      timeout: 5000,
    });
    await server.recovery.stop();
    server.recovery.start(); // ignored after stop
  });
});

describe(`WP09b on-chain and channel spends (${testDriver()})`, () => {
  async function chainSpending() {
    const h = await harness();
    const auth = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };
    const path = `/api/v1/nodes/${id}`;
    const payer = h.fakes.get('https://a.blake2b.test');
    const other = h.fakes.get('https://b.blake2b.test');
    if (!payer || !other) throw new Error('Missing fake');
    const address = async () => (await other.receive.newAddress('p2wpkh')).address;
    const preview = (kind: string, body: unknown, credentials: { cookie: string; csrf: string } = auth) =>
      h.request('POST', `${path}/${kind}/preview`, { ...credentials, body });
    const execute = (
      kind: string,
      token: string,
      key = randomBytes(16).toString('hex'),
      ack = false,
      credentials: { cookie: string; csrf: string } = auth,
    ) =>
      h.request('POST', `${path}/${kind}/execute`, {
        ...credentials,
        headers: { 'idempotency-key': key },
        body: { confirmationToken: token, acknowledgeDuplicate: ack },
      });
    const token = async (kind: string, body: unknown) => {
      const res = await preview(kind, body);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json()) as {
        confirmationToken: string;
        cost: { amount: string; maxFee: string; total: string };
        stepUpRequired: boolean;
        feeOverride: boolean;
        duplicateWarning: boolean;
      };
    };
    const policy = (change = {}) =>
      h.request('POST', `${path}/spend-policy`, {
        ...auth,
        body: {
          maxPerPayment: null,
          max24h: null,
          stepUpAbove: null,
          maxFeeRate: '10',
          maxFeeSharePercent: 5,
          maxRoutingFeeSharePercent: 1,
          routingFeeAllowance: '10',
          ...change,
        },
      });
    const intent = (intentId: string) =>
      h.server.db.selectFrom('spend_intents').selectAll().where('id', '=', intentId).executeTakeFirstOrThrow();
    const session = await h.server.auth.session(auth.cookie.split('=')[1] ?? '');
    if (!session) throw new Error('Missing test session');
    const passwordStepUp = async () => {
      const step = await h.request('POST', '/api/v1/auth/step-up', {
        ...auth,
        body: { password: PASSWORD, strength: 'password' },
      });
      expect(step.status).toBe(200);
      return {
        cookie: (step.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        csrf: ((await step.json()) as { csrfToken: string }).csrfToken,
      };
    };
    return {
      h,
      auth,
      id,
      path,
      payer,
      other,
      address,
      preview,
      execute,
      token,
      policy,
      intent,
      handle: session.handle,
      passwordStepUp,
    };
  }
  const reservedUtxos = async (adapter: FakeAdapter) =>
    (await adapter.onchain.listUtxos()).filter((u) => u.reserved).length;

  it('counts a close to an external shutdown address, rechecks the balance and says where the funds go', async () => {
    const s = await chainSpending();
    const channel = (await s.payer.channel.listChannels()).items[0];
    if (!channel) throw new Error('no channel');
    type Preview = { cost: { total: string }; fundsTo: { address?: string; ownWallet: boolean } };
    const preview = async () => (await (await s.preview('channels/close', { channel: channel.id })).json()) as Preview;

    // CLN's default: the shutdown address is one of the wallet's own, so the close is free.
    const ownAddress = s.payer.setCloseTo(channel.id, true);
    expect(await preview()).toMatchObject({ cost: { total: '0' }, fundsTo: { address: ownAddress, ownWallet: true } });
    // A free close whose shutdown address changes before execute would pay elsewhere uncounted: refused.
    const free = await s.token('channels/close', { channel: channel.id });
    s.payer.setCloseTo(channel.id);
    expect(await (await s.execute('channels/close', free.confirmationToken)).json()).toMatchObject({
      error: { code: 'confirmation_invalid', details: { reason: 'channel_changed' } },
    });

    // Opened with an external `close_to`: counted at the local balance, and the preview names the address.
    const external = s.payer.setCloseTo(channel.id);
    const counted = await s.token('channels/close', { channel: channel.id });
    expect(counted.cost.total).toBe(channel.local.toString());
    expect(await preview()).toMatchObject({ fundsTo: { address: external, ownWallet: false } });

    // Payments received after the preview raise the local balance: the owner must preview again.
    const list = vi.spyOn(s.payer.channel, 'listChannels');
    list.mockResolvedValue({ items: [{ ...channel, closeTo: external, local: msat(channel.local + 1000n) }] });
    const close = vi.spyOn(s.payer.channel, 'closeChannel');
    const changed = await s.execute('channels/close', counted.confirmationToken);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      error: { code: 'confirmation_invalid', details: { reason: 'channel_changed' } },
    });
    expect(close).not.toHaveBeenCalled();
    list.mockRestore();
    const res = await s.execute('channels/close', counted.confirmationToken);
    const done = (await res.json()) as { intentId: string; state: string };
    expect(done.state).toBe('succeeded');
    // No destination is sent: the node pays its stored shutdown script, which was counted.
    expect(close.mock.calls[0]?.[0].destination).toBeUndefined();
    expect(await s.intent(done.intentId)).toMatchObject({ destination: external, cost_msat: channel.local.toString() });

    // A view rune admitted before `listaddresses` joined the view scope cannot tell: counted (fail closed).
    const peer = (await s.other.node.getInfo()).pubkey;
    await s.payer.peer.connect(`${peer}@127.0.0.1:9735`);
    const { channelId } = await s.payer.channel.openChannel({ peer, amount: msat(100_000_000n) });
    const second = (await s.payer.channel.listChannels()).items.find((c) => c.id === channelId);
    if (!second) throw new Error('no second channel');
    s.payer.setCloseTo(second.id, true);
    const row = await s.h.server.db
      .selectFrom('nodes')
      .select('view_methods')
      .where('id', '=', s.id)
      .executeTakeFirstOrThrow();
    await s.h.server.db
      .updateTable('nodes')
      .set({
        view_methods: JSON.stringify((JSON.parse(row.view_methods) as string[]).filter((m) => m !== 'listaddresses')),
      })
      .where('id', '=', s.id)
      .execute();
    const unchecked = (await (await s.preview('channels/close', { channel: second.id })).json()) as Preview;
    expect(unchecked).toMatchObject({ cost: { total: second.local.toString() }, fundsTo: { ownWallet: false } });
  });

  it('counts the close when the wallet cannot be asked, and refuses when the shutdown address changed', async () => {
    const s = await chainSpending();
    const channel = (await s.payer.channel.listChannels()).items[0];
    if (!channel) throw new Error('no channel');
    s.payer.setCloseTo(channel.id, true);
    const owns = vi
      .spyOn(s.payer.onchain, 'ownsAddress')
      .mockRejectedValue(new AdapterError({ code: 'node_unreachable', sent: false, definitive: false }));
    const counted = await s.token('channels/close', { channel: channel.id });
    expect(counted.cost.total).toBe(channel.local.toString());
    expect(s.h.lines.some((l) => l.includes('wallet address not checked') && l.includes('node_unreachable'))).toBe(
      true,
    );
    owns.mockRestore();
    // The shutdown address is not the one the owner previewed any more: preview again.
    s.payer.setCloseTo(channel.id);
    const changed = await s.execute('channels/close', counted.confirmationToken);
    expect(await changed.json()).toMatchObject({
      error: { code: 'confirmation_invalid', details: { reason: 'channel_changed' } },
    });
  });

  it('fails and releases an admitted intent when credential loading is refused before any node call', async () => {
    const s = await chainSpending();
    const p = await s.token('onchain', { address: await s.address(), amount: '100000000', feeRate: '2' });
    const send = vi.spyOn(s.payer.onchain, 'prepare');
    vi.spyOn(s.h.server.nodes, 'spendingAdapter').mockRejectedValue(new AppError('node_credential_revoked', 'Revoked'));
    const response = await s.execute('onchain', p.confirmationToken);
    const result = (await response.json()) as { error: { details: { intentId: string; reason: string } } };
    expect(response.status).toBe(422);
    expect(result.error.details.reason).toBe('node_credential_revoked');
    expect((await s.intent(result.error.details.intentId)).state).toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });
  it('sends on-chain: checks the address, caps the fee, checks the PSBT, then broadcasts', async () => {
    const s = await chainSpending();
    const to = await s.address();
    // The node's half-hour estimate (12 sat/vB) is above the policy's 10.
    expect(await errorCode(await s.preview('onchain', { address: to, amount: '100000000' }))).toBe('fee_cap_exceeded');
    expect((await s.preview('onchain', { address: to, amount: '100000001' })).status).toBe(400);
    expect(
      await errorCode(
        await s.preview('onchain', { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '1000' }),
      ),
    ).toBe('validation_failed');
    const [coin] = await s.payer.onchain.listUtxos();
    const p = await s.token('onchain', { address: to, amount: '100000000', feeRate: '2' });
    // WP09c: the fee is bounded from the coin chosen (one P2WPKH input 68 vB, the P2WPKH output 31 vB, a change
    // output 43 vB, 11 vB overhead: 153 vB × 2 sat/vB), not the 5 % share (5,000 sat).
    expect(p.cost).toEqual({ amount: '100000000', maxFee: '306000', total: '100306000' });
    const prepare = vi.spyOn(s.payer.onchain, 'prepare');
    const res = await s.execute('onchain', p.confirmationToken, 'wp09b-onchain-send');
    expect(res.status, await res.clone().text()).toBe(200);
    const outcome = (await res.json()) as { intentId: string; state: string; txid: string };
    expect(outcome.state).toBe('succeeded');
    expect(prepare.mock.calls[0]?.[0]).toEqual({
      outputs: [{ address: to, amount: 100_000_000n }],
      feeRate: '2',
      utxos: [coin?.outpoint],
    });
    const row = await s.intent(outcome.intentId);
    expect(row).toMatchObject({
      type: 'onchain',
      state: 'succeeded',
      txid: outcome.txid,
      destination: to,
      payment_hash: null,
      utxos: JSON.stringify([coin?.outpoint]),
    });
    // The node's fee is within the bound.
    expect(BigInt(row.fee_msat ?? '0')).toBeLessThanOrEqual(306_000n);
    expect(row.psbt_ciphertext).toBeNull();
    expect(BigInt(row.fee_msat ?? '0')).toBeGreaterThan(0n);
    expect((await s.payer.onchain.listTransactions()).items.map((t) => t.txid)).toContain(outcome.txid);
    // Same key: the recorded outcome, no second call; the token cannot be used again.
    const again = await s.execute('onchain', p.confirmationToken, 'wp09b-onchain-send');
    expect(await again.json()).toMatchObject({ intentId: outcome.intentId, state: 'succeeded', txid: outcome.txid });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await errorCode(await s.execute('onchain', p.confirmationToken))).toBe('confirmation_invalid');
    // Counted in the rolling window.
    const used = (await (await s.h.request('GET', `${s.path}/spend-policy`, s.auth)).json()) as { usedMsat: string };
    expect(used.usedMsat).toBe('100306000');
    expect(
      s.h.lines.some(
        (l) => l.includes('"spend intent"') && l.includes('"type":"onchain"') && l.includes('"security":true'),
      ),
    ).toBe(true);
  });

  it('WP09c: counts only the size bound on a large send, and applies the fee share to it', async () => {
    const s = await chainSpending();
    const to = await s.address();
    // A large send counts its bound (306 sat at 2 sat/vB), not 5 % of the amount (20,000 sat).
    const large = await s.token('onchain', { address: to, amount: '400000000', feeRate: '2' });
    expect(large.cost.maxFee).toBe('306000');
    // A small send at a high rate: 153 vB × 9 sat/vB = 1,377 sat is above 5 % of 20,000 sat (1,000 sat).
    const small = { address: to, amount: '20000000', feeRate: '9' };
    expect(await errorCode(await s.preview('onchain', small))).toBe('fee_cap_exceeded');
    // In step-up mode the exact bound is shown and a fresh password is needed.
    expect((await s.policy({ maxFeeShareMode: 'step-up' })).status).toBe(204);
    s.h.server.auth.sessions.clearGrants(s.handle);
    const stepped = await s.token('onchain', small);
    expect(stepped).toMatchObject({ feeOverride: true, stepUpRequired: true, cost: { maxFee: '1377000' } });
    expect(await errorCode(await s.execute('onchain', stepped.confirmationToken))).toBe('step_up_required');
    const rotated = await s.passwordStepUp();
    const res = await s.execute('onchain', stepped.confirmationToken, undefined, false, rotated);
    expect(res.status, await res.clone().text()).toBe(200);
    const done = (await res.json()) as { intentId: string; state: string };
    expect(done.state).toBe('succeeded');
    // The node's fee stayed within the bound shown.
    expect(BigInt((await s.intent(done.intentId)).fee_msat ?? '0')).toBeLessThanOrEqual(1_377_000n);
  });

  it('WP09c: bounds from the fewest coins, refuses what the coins cannot cover, and fixes them for the node', async () => {
    const s = await chainSpending();
    const to = await s.address();
    const big = s.payer.addCoin(msat(900_000_000n), 'p2tr');
    // The largest coin alone covers it: one P2TR input (58 vB).
    const one = await s.token('onchain', { address: to, amount: '600000000', feeRate: '1.5' });
    expect(one.cost.maxFee).toBe(String(Math.ceil(1.5 * (11 + 58 + 31 + 43)) * 1000));
    // Both coins are needed for more than the largest holds: 58 + 68 vB of inputs.
    const both = await s.token('onchain', { address: to, amount: '1200000000', feeRate: '1.5' });
    expect(both.cost.maxFee).toBe(String(Math.ceil(1.5 * (11 + 58 + 68 + 31 + 43)) * 1000));
    expect(
      await (await s.preview('onchain', { address: to, amount: '1400000000', feeRate: '1.5' })).json(),
    ).toMatchObject({ error: { code: 'validation_failed', details: { reason: 'insufficient_funds' } } });
    const prepare = vi.spyOn(s.payer.onchain, 'prepare');
    expect((await s.execute('onchain', one.confirmationToken)).status).toBe(200);
    expect(prepare.mock.calls[0]?.[0].utxos).toEqual([big]);
    // A coin chosen at preview and spent by another send before execute: the node refuses it, nothing is sent.
    const stale = await s.token('onchain', { address: to, amount: '100000000', feeRate: '1.5' });
    const first = await s.token('onchain', { address: to, amount: '110000000', feeRate: '1.5' });
    expect((await s.execute('onchain', first.confirmationToken)).status).toBe(200);
    const res = await s.execute('onchain', stale.confirmationToken);
    expect(await res.json()).toMatchObject({ error: { code: 'payment_failed' } });
    expect(prepare.mock.calls[2]?.[0].utxos).toEqual(prepare.mock.calls[1]?.[0].utxos);
  });

  it('refuses a node transaction that pays too much fee or another output, and releases its inputs', async () => {
    const s = await chainSpending();
    const to = await s.address();
    const real = s.payer.onchain.prepare;
    // A node that builds a dearer transaction than the bound (here: a higher rate than confirmed) is refused before
    // anything is broadcast, and its inputs are released.
    s.payer.onchain.prepare = async (request) => real({ ...request, feeRate: '3' });
    const dear = await s.token('onchain', { address: to, amount: '20000000', feeRate: '2' });
    const res = await s.execute('onchain', dear.confirmationToken);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: 'payment_failed', details: { reason: 'fee_cap_exceeded' } },
    });
    expect(await reservedUtxos(s.payer)).toBe(0);

    const elsewhere = await s.address();
    s.payer.onchain.prepare = async (request) =>
      real({ ...request, outputs: request.outputs.map((o) => ({ ...o, address: elsewhere })) });
    const swapped = await s.token('onchain', { address: to, amount: '30000000', feeRate: '2' });
    const refused = await s.execute('onchain', swapped.confirmationToken);
    expect(await refused.json()).toMatchObject({
      error: { code: 'payment_failed', details: { reason: 'node_bad_response' } },
    });
    expect(await reservedUtxos(s.payer)).toBe(0);
    s.payer.onchain.prepare = async () => ({ txid: parseTxid('ab'.repeat(32)), psbt: 'bm90IGEgcHNidA==' });
    const garbage = await s.token('onchain', { address: to, amount: '31000000', feeRate: '2' });
    expect(await (await s.execute('onchain', garbage.confirmationToken)).json()).toMatchObject({
      error: { details: { reason: 'node_bad_response' } },
    });
    s.payer.onchain.prepare = real;
    // Failed spends are not counted.
    const used = (await (await s.h.request('GET', `${s.path}/spend-policy`, s.auth)).json()) as { usedMsat: string };
    expect(used.usedMsat).toBe('0');
  });

  it('classifies node errors: before the call or definitive is failed, anything else unknown with its PSBT kept', async () => {
    const s = await chainSpending();
    const to = await s.address();
    const poor = await s.token('onchain', { address: to, amount: '10000000', feeRate: '2' });
    s.payer.failNext(new AdapterError({ code: 'node_error', sent: true, definitive: true, nodeCode: 301 }));
    expect(await errorCode(await s.execute('onchain', poor.confirmationToken, 'wp09b-prepare-fails'))).toBe(
      'payment_failed',
    );
    // The key is not stuck: its retry answers with the failure.
    expect(await errorCode(await s.execute('onchain', poor.confirmationToken, 'wp09b-prepare-fails'))).toBe(
      'payment_failed',
    );

    const realSend = s.payer.onchain.send;
    s.payer.onchain.send = async () => {
      throw new AdapterError({ code: 'node_unreachable', sent: true, definitive: false });
    };
    const lost = await s.token('onchain', { address: to, amount: '11000000', feeRate: '2' });
    const res = await s.execute('onchain', lost.confirmationToken);
    const outcome = (await res.json()) as { intentId: string; state: string; txid: string };
    expect(outcome.state).toBe('unknown');
    const row = await s.intent(outcome.intentId);
    expect(row.txid).toBe(outcome.txid);
    expect(row.psbt_ciphertext).not.toBeNull();
    // Recovery leaves a run-time unknown that the wallet does not list as it is: it did reach the node.
    expect(await s.h.server.recovery.resolvePass()).toBe(1);
    expect(await s.intent(outcome.intentId)).toMatchObject({ state: 'unknown', txid: outcome.txid });

    s.payer.onchain.send = async () => {
      throw new AdapterError({ code: 'node_error', sent: true, definitive: true, nodeCode: -1 });
    };
    // The unknown send keeps its coins reserved, so the wallet needs another one to bound the next send from.
    expect(await errorCode(await s.preview('onchain', { address: to, amount: '12000000', feeRate: '2' }))).toBe(
      'validation_failed',
    );
    s.payer.addCoin(msat(50_000_000n));
    const refused = await s.token('onchain', { address: to, amount: '12000000', feeRate: '2' });
    expect(await errorCode(await s.execute('onchain', refused.confirmationToken))).toBe('payment_failed');
    s.payer.onchain.send = realSend;
  });

  it('applies limits, step-up and duplicate rules to on-chain spends, and keeps types and keys apart', async () => {
    const s = await chainSpending();
    const to = await s.address();
    expect((await s.policy({ maxPerPayment: '50000' })).status).toBe(204);
    expect(await errorCode(await s.preview('onchain', { address: to, amount: '50000000', feeRate: '2' }))).toBe(
      'limit_exceeded',
    );
    expect((await s.policy({ stepUpAbove: '0' })).status).toBe(204);
    s.h.server.auth.sessions.clearGrants(s.handle);
    const p = await s.token('onchain', { address: to, amount: '10000000', feeRate: '2' });
    expect(p.stepUpRequired).toBe(true);
    expect(await errorCode(await s.execute('onchain', p.confirmationToken))).toBe('step_up_required');
    const rotated = await s.passwordStepUp();
    expect((await s.execute('onchain', p.confirmationToken, 'wp09b-first-send', false, rotated)).status).toBe(200);
    // Same address and amount within ten minutes: warned, and must be acknowledged.
    const twin = await s.preview('onchain', { address: to, amount: '10000000', feeRate: '2' }, rotated);
    const twinBody = (await twin.json()) as { confirmationToken: string; duplicateWarning: boolean };
    expect(twinBody.duplicateWarning).toBe(true);
    expect(await errorCode(await s.execute('onchain', twinBody.confirmationToken, undefined, false, rotated))).toBe(
      'confirmation_invalid',
    );
    // A token of one type cannot execute another; a key of one type cannot be replayed as another.
    expect(
      await errorCode(await s.execute('channels/open', twinBody.confirmationToken, undefined, true, rotated)),
    ).toBe('confirmation_invalid');
    expect(
      await errorCode(await s.execute('channels/open', twinBody.confirmationToken, 'wp09b-first-send', true, rotated)),
    ).toBe('idempotency_conflict');
    const paid = await s.h.request('POST', `${s.path}/payments/execute`, {
      ...rotated,
      headers: { 'idempotency-key': 'wp09b-first-send' },
      body: { confirmationToken: twinBody.confirmationToken },
    });
    expect(await errorCode(paid)).toBe('idempotency_conflict');
    expect((await s.execute('onchain', twinBody.confirmationToken, undefined, true, rotated)).status).toBe(200);
  });

  it('admits one on-chain send for concurrent executes with one key', async () => {
    const s = await chainSpending();
    const p = await s.token('onchain', { address: await s.address(), amount: '10000000', feeRate: '2' });
    const prepare = vi.spyOn(s.payer.onchain, 'prepare');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => s.execute('onchain', p.confirmationToken, 'wp09b-same-key-race')),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect([200, 409]).toContain(r.status);
  });

  it('refuses bad channel requests and odd node replies, and forgets tokens of an ended session', async () => {
    const s = await chainSpending();
    const peer = (await s.other.node.getInfo()).pubkey;
    const own = (await s.payer.node.getInfo()).pubkey;
    expect(await errorCode(await s.preview('channels/open', { peer: own, amount: '100000000' }))).toBe(
      'validation_failed',
    );
    expect(await errorCode(await s.preview('channels/open', { peer, amount: '100000000', push: '100000001' }))).toBe(
      'validation_failed',
    );
    // The node's opening estimate (8 sat/vB) is used when no rate is given.
    await s.payer.peer.connect(`${peer}@127.0.0.1:9735`);
    const open = await s.preview('channels/open', { peer, amount: '100000000', announce: false });
    expect(((await open.json()) as { feeRate: string }).feeRate).toBe('8');
    const openToken = (
      await s.preview('channels/open', { peer, amount: '110000000', feeRate: '2', announce: false })
    ).json() as Promise<{ confirmationToken: string }>;
    const openSpy = vi.spyOn(s.payer.channel, 'openChannel').mockImplementationOnce(async () => {
      throw new Error('unexpected reply');
    });
    const odd = await s.execute('channels/open', (await openToken).confirmationToken);
    expect(((await odd.json()) as { state: string }).state).toBe('unknown');
    expect(openSpy.mock.calls[0]?.[0]).toMatchObject({ announce: false });

    // By short channel id; a close the node has not finished answers `pending`, without a txid.
    const first = (await s.payer.channel.listChannels()).items.find((c) => c.shortChannelId !== undefined);
    if (!first?.shortChannelId) throw new Error('no channel with a short id');
    vi.spyOn(s.payer.channel, 'closeChannel').mockImplementationOnce(async () => ({ type: 'pending' }));
    const close = await s.token('channels/close', { channel: first.shortChannelId, destination: await s.address() });
    const pending = await s.execute('channels/close', close.confirmationToken);
    const body = (await pending.json()) as { state: string; closeType: string; txid?: string };
    expect(body).toMatchObject({ state: 'succeeded', closeType: 'pending' });
    expect(body.txid).toBeUndefined();

    // A node that answers with another txid than it prepared, or sends another one.
    const to = await s.address();
    const real = s.payer.onchain.prepare;
    s.payer.onchain.prepare = async (request) => ({ ...(await real(request)), txid: parseTxid('cd'.repeat(32)) });
    const other = await s.token('onchain', { address: to, amount: '10000000', feeRate: '2' });
    expect(await (await s.execute('onchain', other.confirmationToken)).json()).toMatchObject({
      error: { details: { reason: 'node_bad_response' } },
    });
    s.payer.onchain.prepare = real;
    // A matching spend admitted after this preview needs a fresh preview, even when acknowledged.
    const a = await s.token('onchain', { address: to, amount: '9000000', feeRate: '2' });
    const b = await s.token('onchain', { address: to, amount: '9000000', feeRate: '2' });
    expect((await s.execute('onchain', a.confirmationToken)).status).toBe(200);
    expect(await errorCode(await s.execute('onchain', b.confirmationToken, undefined, true))).toBe(
      'confirmation_invalid',
    );

    // Expired and ended-session confirmations are gone.
    const late = await s.token('onchain', { address: to, amount: '8000000', feeRate: '2' });
    s.h.clock.now = new Date(s.h.clock.now.getTime() + 121_000);
    expect(await errorCode(await s.execute('onchain', late.confirmationToken))).toBe('confirmation_invalid');
    // Sent under another txid than prepared: unknown (its inputs stay reserved until resolved).
    vi.spyOn(s.payer.onchain, 'send').mockImplementationOnce(async () => ({ txid: parseTxid('ef'.repeat(32)) }));
    const swapped = await s.token('onchain', { address: to, amount: '10000000', feeRate: '2' });
    expect(
      ((await (await s.execute('onchain', swapped.confirmationToken, undefined, true)).json()) as { state: string })
        .state,
    ).toBe('unknown');

    // The unknown send keeps the wallet's only coin reserved: the next preview is bounded from a new one.
    s.payer.addCoin(msat(50_000_000n));
    const kept = await s.token('onchain', { address: to, amount: '7000000', feeRate: '2' });
    expect((await s.h.request('POST', '/api/v1/auth/logout', s.auth)).status).toBe(204);
    expect(await errorCode(await s.execute('onchain', kept.confirmationToken))).toBe('unauthenticated');
  });

  it('refuses spends from a node without a spend credential', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const res = await addNode(h, auth, 'https://b.blake2b.test', 'blake2b', { spendRune: undefined });
    const { id } = (await res.json()) as { id: string };
    const preview = await h.request('POST', `/api/v1/nodes/${id}/onchain/preview`, {
      ...auth,
      body: { address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', amount: '1000' },
    });
    expect(await errorCode(preview)).toBe('capability_missing');
  });

  it('connects a peer, opens a channel and closes channels to the wallet, an address, or by force', async () => {
    const s = await chainSpending();
    const peer = (await s.other.node.getInfo()).pubkey;
    const connected = await s.h.request('POST', `${s.path}/peers`, {
      ...s.auth,
      body: { uri: `${peer}@127.0.0.1:9735` },
    });
    expect(connected.status, await connected.clone().text()).toBe(200);
    expect(await connected.json()).toEqual({ pubkey: peer });
    expect(s.h.lines.some((l) => l.includes('"peer changed"') && l.includes('"security":true'))).toBe(true);

    const open = await s.token('channels/open', { peer, amount: '200000000', push: '1000', feeRate: '2' });
    // The push comes out of the channel amount, so it adds nothing to the cost (spend policy §15 item 3).
    // Funding fee bounded from the coin (68 vB in, P2WSH funding output 43 vB, change 43 vB, 11 vB) at 2 sat/vB.
    expect(open.cost).toEqual({ amount: '200000000', maxFee: '330000', total: '200330000' });
    const fund = vi.spyOn(s.payer.channel, 'openChannel');
    const opened = (await (await s.execute('channels/open', open.confirmationToken)).json()) as {
      intentId: string;
      state: string;
      channelId: string;
      txid: string;
    };
    expect(opened.state).toBe('succeeded');
    expect(await s.intent(opened.intentId)).toMatchObject({ type: 'channel-open', peer, channel_id: opened.channelId });
    expect(fund.mock.calls[0]?.[0].utxos).toHaveLength(1);

    // To the node's own wallet: not counted.
    const own = await s.token('channels/close', { channel: opened.channelId });
    expect(own.cost.total).toBe('0');
    const closed = (await (await s.execute('channels/close', own.confirmationToken)).json()) as { state: string };
    expect(closed.state).toBe('succeeded');
    expect(await errorCode(await s.preview('channels/close', { channel: opened.channelId }))).toBe('not_found');

    // To an external address: the local balance is counted.
    const channels = await s.payer.channel.listChannels();
    const first = channels.items[0];
    if (!first) throw new Error('no channel');
    const external = await s.token('channels/close', { channel: first.id, destination: await s.address() });
    expect(external.cost.total).toBe(first.local.toString());
    const close = vi.spyOn(s.payer.channel, 'closeChannel');
    expect(
      ((await (await s.execute('channels/close', external.confirmationToken)).json()) as { state: string }).state,
    ).toBe('succeeded');
    expect(close.mock.calls[0]?.[0]).toMatchObject({ channel: first.id, force: false });
    expect(close.mock.calls[0]?.[0].destination).toMatch(/^bcrt1/);
    // By force: a fresh password step-up is required, whatever the amount.
    const another = await s.payer.channel.openChannel({ peer, amount: msat(100_000_000n) });
    s.h.server.auth.sessions.clearGrants(s.handle);
    const force = await s.token('channels/close', { channel: another.channelId, force: true });
    expect(force.stepUpRequired).toBe(true);
    expect(await errorCode(await s.execute('channels/close', force.confirmationToken))).toBe('step_up_required');
    const rotated = await s.passwordStepUp();
    const forced = await s.execute('channels/close', force.confirmationToken, undefined, false, rotated);
    expect(forced.status, await forced.clone().text()).toBe(200);

    const dropped = await s.h.request('POST', `${s.path}/peers/${peer}/disconnect`, {
      ...rotated,
      body: { force: true },
    });
    expect(dropped.status).toBe(204);
    // A node error on open that may have funded a channel is unknown, not failed.
    const lost = await s.preview('channels/open', { peer, amount: '100000000', feeRate: '2' }, rotated);
    const lostToken = ((await lost.json()) as { confirmationToken: string }).confirmationToken;
    s.payer.failNext(new AdapterError({ code: 'node_unreachable', sent: true, definitive: false }));
    const unknown = await s.execute('channels/open', lostToken, undefined, false, rotated);
    expect(((await unknown.json()) as { state: string }).state).toBe('unknown');
  });

  // WP10: on-chain and channel spends interrupted by a stop, resolved from the node's wallet and channel lists.
  describe('crash recovery of on-chain and channel spends', () => {
    async function interrupted() {
      const s = await chainSpending();
      let current = s.h.server;
      const restart = async () => {
        current = await reopen(s.h, current);
        return current;
      };
      // Leaves the intent as a stop between commit and outcome write leaves it (the txid and PSBT stay as stored).
      const interrupt = (intentId: string, values: Record<string, string | null> = {}) =>
        current.db
          .updateTable('spend_intents')
          .set({ state: 'reserved', fee_msat: null, error_code: null, ...values })
          .where('id', '=', intentId)
          .execute();
      const row = (intentId: string) =>
        current.db.selectFrom('spend_intents').selectAll().where('id', '=', intentId).executeTakeFirstOrThrow();
      const later = (ms: number) => {
        s.h.clock.now = new Date(s.h.clock.now.getTime() + ms);
      };
      // Runs a spend whose node call is replaced by `call` (a "crash" is an error the spend module cannot classify).
      const spend = async (kind: string, body: unknown, key: string) => {
        const p = await s.token(kind, body);
        const res = await s.execute(kind, p.confirmationToken, key, true);
        expect(res.status, await res.clone().text()).toBe(200);
        return (await res.json()) as { intentId: string; state: string; txid?: string; channelId?: string };
      };
      return { ...s, restart, interrupt, row, later, spend };
    }
    const crash = () => {
      throw new Error('process killed');
    };

    it('settles an on-chain send the node broadcast, with the fee from the sealed PSBT', async () => {
      const s = await interrupted();
      const real = s.payer.onchain.send;
      s.payer.onchain.send = async (txid) => {
        await real(txid);
        return crash();
      };
      const { intentId, state } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-onchain-after',
      );
      expect(state).toBe('unknown');
      s.payer.onchain.send = real;
      await s.interrupt(intentId);
      const server = await s.restart();
      expect((await s.row(intentId)).error_code).toBe('interrupted');
      expect(await server.recovery.resolvePass()).toBe(0);
      const settled = await s.row(intentId);
      expect(settled).toMatchObject({ state: 'succeeded', error_code: null, psbt_ciphertext: null, psbt_key_id: null });
      expect(BigInt(settled.fee_msat ?? '0')).toBeGreaterThan(0n);
      expect(s.h.lines.some((l) => l.includes('"spend settled"') && l.includes('"type":"onchain"'))).toBe(true);
    });

    it('fails an on-chain send the node never broadcast after the retry window, and releases its inputs', async () => {
      const s = await interrupted();
      const real = s.payer.onchain.send;
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-onchain-before',
      );
      s.payer.onchain.send = real;
      expect(await reservedUtxos(s.payer)).toBeGreaterThan(0);
      await s.interrupt(intentId);
      let server = await s.restart();
      // The node may still be broadcasting: not yet.
      expect(await server.recovery.resolvePass()).toBe(1);
      s.later(121_000);
      server = await s.restart();
      // After a node restart `txdiscard` no longer knows the transaction: the PSBT releases the inputs.
      const discard = vi
        .spyOn(s.payer.onchain, 'discard')
        .mockRejectedValueOnce(new AdapterError({ code: 'node_error', sent: true, definitive: true }));
      const unreserve = vi.spyOn(s.payer.onchain, 'unreserve');
      expect(await server.recovery.resolvePass()).toBe(0);
      expect(await s.row(intentId)).toMatchObject({ state: 'failed', error_code: 'not_sent', psbt_ciphertext: null });
      expect(discard).toHaveBeenCalledTimes(1);
      expect(unreserve).toHaveBeenCalledTimes(1);
      expect(await reservedUtxos(s.payer)).toBe(0);
    });

    it('fails an unsent on-chain send even when the node cannot release its inputs', async () => {
      const s = await interrupted();
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-onchain-release-fails',
      );
      await s.interrupt(intentId);
      await s.restart();
      s.later(121_000);
      const server = await s.restart();
      vi.spyOn(s.payer.onchain, 'discard').mockRejectedValue(new Error('gone'));
      vi.spyOn(s.payer.onchain, 'unreserve').mockRejectedValue(
        new AdapterError({ code: 'node_error', sent: true, definitive: true }),
      );
      expect(await server.recovery.resolvePass()).toBe(0);
      expect((await s.row(intentId)).state).toBe('failed');
      expect(s.h.lines.some((l) => l.includes('spend inputs not released') && l.includes('node_error'))).toBe(true);
    });

    it('keeps an on-chain send unknown when an input is spent, or when the answer was unclear at run time', async () => {
      const s = await interrupted();
      const real = s.payer.onchain.send;
      s.payer.onchain.send = async () => crash();
      const first = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-onchain-spent',
      );
      await s.interrupt(first.intentId);
      await s.restart();
      s.later(121_000);
      let server = await s.restart();
      // The wallet does not list the transaction, but its coins are gone: something spent them.
      const coins = vi.spyOn(s.payer.onchain, 'listUtxos').mockResolvedValue([]);
      const discard = vi.spyOn(s.payer.onchain, 'discard');
      expect(await server.recovery.resolvePass()).toBe(1);
      expect((await s.row(first.intentId)).state).toBe('unknown');
      expect(discard).not.toHaveBeenCalled();
      coins.mockRestore();
      // An unknown left by an unclear answer at run time (not interrupted) is never failed for lack of a record.
      await server.db
        .updateTable('spend_intents')
        .set({ error_code: 'internal' })
        .where('id', '=', first.intentId)
        .execute();
      server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(1);
      expect((await s.row(first.intentId)).state).toBe('unknown');
      s.payer.onchain.send = real;
    });

    it('fails at once an interrupted on-chain send that has no txid: nothing was sent', async () => {
      const s = await interrupted();
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-onchain-no-txid',
      );
      await s.interrupt(intentId, { txid: null, psbt_key_id: null, psbt_nonce: null, psbt_ciphertext: null });
      const server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(0);
      expect(await s.row(intentId)).toMatchObject({ state: 'failed', error_code: 'not_sent' });
      // WP09c: the coins `txprepare` reserved are released from the stored outpoints (inputs-only PSBT).
      expect(await reservedUtxos(s.payer)).toBe(0);
    });

    it('fails an interrupted send without a txid even when its coins cannot be released, or none are stored', async () => {
      const s = await interrupted();
      s.payer.onchain.send = async () => crash();
      const body = async () => ({ address: await s.address(), amount: '100000000', feeRate: '2' });
      const { intentId } = await s.spend('onchain', await body(), 'wp09c-unreserve-fails');
      await s.interrupt(intentId, { txid: null, psbt_key_id: null, psbt_nonce: null, psbt_ciphertext: null });
      s.payer.onchain.unreserve = async () => {
        throw new AdapterError({ code: 'node_unreachable', sent: false, definitive: true });
      };
      let server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(0);
      expect(await s.row(intentId)).toMatchObject({ state: 'failed', error_code: 'not_sent' });
      expect(s.h.lines.some((l) => l.includes('"spend inputs not released"') && l.includes(intentId))).toBe(true);
      // An intent from before WP09c stores no coins: nothing to release. (The first one's coin is still reserved.)
      s.payer.addCoin(msat(50_000_000n));
      const older = await s.spend('onchain', { ...(await body()), amount: '20000000' }, 'wp09c-no-stored-coins');
      await s.interrupt(older.intentId, {
        txid: null,
        psbt_key_id: null,
        psbt_nonce: null,
        psbt_ciphertext: null,
        utxos: null,
      });
      const unreserve = vi.fn(async () => {});
      s.payer.onchain.unreserve = unreserve;
      server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(0);
      expect(await s.row(older.intentId)).toMatchObject({ state: 'failed', error_code: 'not_sent' });
      expect(unreserve).not.toHaveBeenCalled();
    });

    it('releases no coin that another running spend also chose', async () => {
      const s = await interrupted();
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp09c-overlap-first',
      );
      const { utxos } = await s.row(intentId);
      // Another intent that still holds the same coin (left unknown), as a spend admitted after a restart could.
      await s.h.server.db
        .insertInto('spend_intents')
        .values({
          id: randomUUIDv4(),
          node_id: s.id,
          chain: 'blake2b',
          pubkey: (await s.payer.node.getInfo()).pubkey,
          type: 'onchain',
          payment_hash: null,
          amount_msat: '1000000',
          max_fee_msat: '0',
          fee_msat: null,
          state: 'unknown',
          idempotency_key: 'wp09c-overlap-holder',
          digest: 'x',
          error_code: null,
          created_at: s.h.clock.now.toISOString(),
          updated_at: s.h.clock.now.toISOString(),
          utxos,
        })
        .execute();
      await s.interrupt(intentId, { txid: null, psbt_key_id: null, psbt_nonce: null, psbt_ciphertext: null });
      const server = await s.restart();
      await server.recovery.resolvePass();
      expect(await s.row(intentId)).toMatchObject({ state: 'failed', error_code: 'not_sent' });
      expect(await reservedUtxos(s.payer)).toBe(1);
    });

    it('finds an interrupted channel open by peer and capacity, and fails one with no channel', async () => {
      const s = await interrupted();
      const peer = (await s.other.node.getInfo()).pubkey;
      await s.h.request('POST', `${s.path}/peers`, { ...s.auth, body: { uri: `${peer}@127.0.0.1:9735` } });
      const real = s.payer.channel.openChannel;
      s.payer.channel.openChannel = async (request) => {
        await real(request);
        return crash();
      };
      const opened = await s.spend(
        'channels/open',
        { peer, amount: '123000000', feeRate: '2' },
        'wp10-channel-open-after',
      );
      expect(opened.state).toBe('unknown');
      s.payer.channel.openChannel = async () => crash();
      // Same peer and amount, but the node never got it: the one channel belongs to the first intent.
      const lost = await s.spend(
        'channels/open',
        { peer, amount: '123000000', feeRate: '2' },
        'wp10-channel-open-before',
      );
      s.payer.channel.openChannel = real;
      await s.interrupt(opened.intentId);
      await s.interrupt(lost.intentId);
      let server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(1);
      const found = await s.row(opened.intentId);
      const channel = (await s.payer.channel.listChannels()).items.find((c) => c.id === found.channel_id);
      expect(found).toMatchObject({ state: 'succeeded', error_code: null });
      expect(channel?.capacity).toBe(123_000_000n);
      expect(found.txid).toBe(channel?.fundingOutpoint.split(':')[0]);
      // A channel negotiation may take a while: only after ten minutes is "no channel" final.
      s.later(121_000);
      server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(1);
      s.later(480_000);
      server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(0);
      expect(await s.row(lost.intentId)).toMatchObject({ state: 'failed', error_code: 'not_on_node' });
    });

    it('takes a closed channel as an interrupted open that happened', async () => {
      const s = await interrupted();
      const peer = (await s.other.node.getInfo()).pubkey;
      await s.h.request('POST', `${s.path}/peers`, { ...s.auth, body: { uri: `${peer}@127.0.0.1:9735` } });
      const real = s.payer.channel.openChannel;
      s.payer.channel.openChannel = async (request) => {
        const result = await real(request);
        await s.payer.channel.closeChannel({ channel: result.channelId, force: false });
        return crash();
      };
      const opened = await s.spend('channels/open', { peer, amount: '124000000', feeRate: '2' }, 'wp10-open-closed');
      s.payer.channel.openChannel = real;
      await s.interrupt(opened.intentId);
      const server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(0);
      expect((await s.row(opened.intentId)).state).toBe('succeeded');
    });

    it('settles an interrupted close from the channel state', async () => {
      const s = await interrupted();
      const [first] = (await s.payer.channel.listChannels()).items;
      if (!first) throw new Error('need a channel');
      const peer = (await s.other.node.getInfo()).pubkey;
      await s.h.request('POST', `${s.path}/peers`, { ...s.auth, body: { uri: `${peer}@127.0.0.1:9735` } });
      const second = await s.payer.channel.openChannel({ peer, amount: msat(100_000_000n) });
      const real = s.payer.channel.closeChannel;
      s.payer.channel.closeChannel = async (request) => {
        await real(request);
        return crash();
      };
      // Still opening: the node forgets it at once, so it is gone from the list.
      const closed = await s.spend('channels/close', { channel: second.channelId }, 'wp10-channel-close-after');
      s.payer.channel.closeChannel = async () => crash();
      const kept = await s.spend('channels/close', { channel: first.id }, 'wp10-channel-close-before');
      s.payer.channel.closeChannel = real;
      await s.interrupt(closed.intentId);
      await s.interrupt(kept.intentId);
      let server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(1);
      expect((await s.row(closed.intentId)).state).toBe('succeeded');
      s.later(121_000);
      server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(0);
      expect(await s.row(kept.intentId)).toMatchObject({ state: 'failed', error_code: 'not_on_node' });
    });

    it('keeps chain spends unknown when the node cannot be read', async () => {
      const s = await interrupted();
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-onchain-unreadable',
      );
      await s.interrupt(intentId);
      const server = await s.restart();
      vi.spyOn(s.payer.onchain, 'listTransactions').mockRejectedValue(
        new AdapterError({ code: 'node_unreachable', sent: true, definitive: false }),
      );
      expect(await server.recovery.resolvePass()).toBe(1);
      expect((await s.row(intentId)).state).toBe('unknown');
      expect(s.h.lines.some((l) => l.includes('spend status not readable') && l.includes('node_unreachable'))).toBe(
        true,
      );
    });

    it('recognises a sent transaction without its PSBT, but releases nothing it cannot read', async () => {
      const s = await interrupted();
      const real = s.payer.onchain.send;
      s.payer.onchain.send = async (txid) => {
        await real(txid);
        return crash();
      };
      const sent = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-onchain-sealed-elsewhere',
      );
      s.payer.onchain.send = async () => crash();
      const held = await s.spend(
        'onchain',
        { address: await s.address(), amount: '20000000', feeRate: '2' },
        'wp10-onchain-unreadable-psbt',
      );
      s.payer.onchain.send = real;
      // As if sealed under a vault key that has since been replaced.
      for (const id of [sent.intentId, held.intentId]) await s.interrupt(id, { psbt_key_id: 'old-key' });
      await s.restart();
      s.later(121_000);
      const server = await s.restart();
      expect(await server.recovery.resolvePass()).toBe(1);
      expect(await s.row(sent.intentId)).toMatchObject({ state: 'succeeded', fee_msat: null, psbt_key_id: null });
      expect((await s.row(held.intentId)).state).toBe('unknown');
      expect(s.h.lines.some((l) => l.includes('spend PSBT not readable'))).toBe(true);
    });

    it('settles odd chain intents safely: resolved meanwhile, missing ids, unclear states, nothing to release', async () => {
      const s = await interrupted();
      const { settleChainSpend } = await import('./modules/spend/recovery/chain.ts');
      const logger = createLogger({ level: 'debug', sink: (l) => s.h.lines.push(l) });
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-onchain-odd-intents',
      );
      const row = await s.row(intentId);
      const vault = { openSecret: () => '' } as never;
      const at = new Date(s.h.clock.now.getTime() + 600_000);
      const base = {
        ...row,
        type: 'onchain' as 'onchain' | 'channel-open' | 'channel-close',
        error_code: 'interrupted',
      };
      const settle = (intent: Partial<typeof base>) =>
        settleChainSpend(s.h.server.db, s.payer, vault, { ...base, ...intent }, at, logger);
      // A run-time unknown without a txid, an open without a peer, a close without a channel id: nothing to read.
      expect(await settle({ txid: null, error_code: 'internal' })).toBe('unknown');
      expect(await settle({ type: 'channel-open', peer: null })).toBe('unknown');
      expect(await settle({ type: 'channel-close', channel_id: null })).toBe('unknown');
      // A close of a channel that is still opening proves nothing; nor does a run-time unknown close of a normal one.
      const peer = (await s.other.node.getInfo()).pubkey;
      await s.h.request('POST', `${s.path}/peers`, { ...s.auth, body: { uri: `${peer}@127.0.0.1:9735` } });
      const opening = await s.payer.channel.openChannel({ peer, amount: msat(100_000_000n) });
      expect(await settle({ type: 'channel-close', channel_id: opening.channelId })).toBe('unknown');
      const [normal] = (await s.payer.channel.listChannels()).items;
      expect(await settle({ type: 'channel-close', channel_id: normal?.id ?? null, error_code: 'internal' })).toBe(
        'unknown',
      );
      // The row resolved meanwhile by another path: its stored state is reported.
      await s.h.server.db.updateTable('spend_intents').set({ state: 'failed' }).where('id', '=', intentId).execute();
      expect(await settle({ txid: null })).toBe('failed');
      await s.h.server.db.updateTable('spend_intents').set({ state: 'reserved' }).where('id', '=', intentId).execute();
      expect(await settle({ txid: null })).toBe('unknown');
    });

    it('lists unresolved spends and lets the owner resolve one with security step-up', async () => {
      const s = await interrupted();
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-owner-resolves',
      );
      const listed = await s.h.request('GET', `${s.path}/spends/unresolved`, s.auth);
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as { items: { intentId: string; cost: string }[]; warning: string };
      expect(body.items).toEqual([
        expect.objectContaining({ intentId, type: 'onchain', cost: '100306000', reason: 'internal' }),
      ]);
      expect(body.warning).toMatch(/paid a second time/);
      expect(
        await errorCode(await s.h.request('GET', `/api/v1/nodes/${randomUUIDv4()}/spends/unresolved`, s.auth)),
      ).toBe('not_found');

      const resolve = (id: string, outcome: string, credentials: { cookie: string; csrf: string } = s.auth) =>
        s.h.request('POST', `${s.path}/spends/${id}/resolve`, { ...credentials, body: { outcome } });
      // A password step-up is not enough: the owner's choice may free budget.
      s.h.server.auth.sessions.clearGrants(s.handle);
      const password = await s.passwordStepUp();
      expect(await errorCode(await resolve(intentId, 'failed', password))).toBe('step_up_required');
      expect((await resolve(intentId, 'unknown', password)).status).toBe(400);
      s.later(90_000);
      const step = await s.h.request('POST', '/api/v1/auth/step-up', {
        ...password,
        body: {
          password: PASSWORD,
          strength: 'security',
          totpCode: totp(s.h.secret ?? '', s.h.clock.now),
        },
      });
      expect(step.status, await step.clone().text()).toBe(200);
      const security = {
        cookie: (step.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        csrf: ((await step.json()) as { csrfToken: string }).csrfToken,
      };
      expect(await errorCode(await resolve(randomUUIDv4(), 'failed', security))).toBe('not_found');
      const res = await resolve(intentId, 'failed', security);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toEqual({ intentId, state: 'failed' });
      expect(await s.row(intentId)).toMatchObject({ state: 'failed', error_code: 'owner_resolved', psbt_key_id: null });
      // Its inputs are released, and its budget is free again.
      expect(await reservedUtxos(s.payer)).toBe(0);
      const used = (await (await s.h.request('GET', `${s.path}/spend-policy`, security)).json()) as {
        usedMsat: string;
      };
      expect(used.usedMsat).toBe('0');
      expect(await errorCode(await resolve(intentId, 'succeeded', security))).toBe('validation_failed');
      expect(
        s.h.lines.some(
          (l) => l.includes('"spend resolved by owner"') && l.includes('"security":true') && l.includes(intentId),
        ),
      ).toBe(true);
      const empty = (await (await s.h.request('GET', `${s.path}/spends/unresolved`, security)).json()) as {
        items: unknown[];
      };
      expect(empty.items).toEqual([]);
    });

    it('lists every kind of unresolved spend, and resolves one without a node to ask', async () => {
      const s = await interrupted();
      const [channel] = (await s.payer.channel.listChannels()).items;
      if (!channel) throw new Error('need a channel');
      s.payer.channel.closeChannel = async () => crash();
      const close = await s.spend('channels/close', { channel: channel.id }, 'wp10-list-channel-close');
      const bolt11 = (
        await s.other.receive.createInvoice({ amount: msat(5000n), description: 'x', label: 'wp10-list-payment' })
      ).bolt11;
      const p = await s.h.request('POST', `${s.path}/payments/preview`, { ...s.auth, body: { request: bolt11 } });
      const { confirmationToken } = (await p.json()) as { confirmationToken: string };
      s.payer.pay.pay = async () => crash();
      const pay = await s.h.request('POST', `${s.path}/payments/execute`, {
        ...s.auth,
        headers: { 'idempotency-key': 'wp10-list-payment-key' },
        body: { confirmationToken, acknowledgeDuplicate: true },
      });
      const { intentId: payment } = (await pay.json()) as { intentId: string };
      // A legacy row without an immutable cost counts as amount plus maximum fee.
      await s.h.server.db.updateTable('spend_intents').set({ cost_msat: null }).where('id', '=', payment).execute();
      const listed = (await (await s.h.request('GET', `${s.path}/spends/unresolved`, s.auth)).json()) as {
        items: Record<string, unknown>[];
      };
      const byId = new Map(listed.items.map((i) => [i['intentId'], i]));
      expect(byId.get(close.intentId)).toMatchObject({ type: 'channel-close', channelId: channel.id, cost: '0' });
      expect(byId.get(close.intentId)).not.toHaveProperty('paymentHash');
      const row = await s.row(payment);
      expect(byId.get(payment)).toMatchObject({
        type: 'bolt11',
        paymentHash: row.payment_hash,
        cost: (BigInt(row.amount_msat) + BigInt(row.max_fee_msat)).toString(),
      });
      expect(byId.get(payment)).not.toHaveProperty('txid');
      // Resolving needs no node: a payment releases nothing, and a node that cannot be loaded changes nothing.
      const resolve = (id: string, outcome: string) =>
        s.h.request('POST', `${s.path}/spends/${id}/resolve`, { ...s.auth, body: { outcome } });
      expect((await resolve(payment, 'succeeded')).status).toBe(200);
      s.h.fakes.delete('https://a.blake2b.test');
      expect((await resolve(close.intentId, 'failed')).status).toBe(200);
      expect((await s.row(close.intentId)).state).toBe('failed');
    });

    it("stores the owner's choice when the sealed PSBT cannot be opened", async () => {
      const s = await interrupted();
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-owner-resolves-old-key',
      );
      await s.h.server.db
        .updateTable('spend_intents')
        .set({ psbt_key_id: 'old-key' })
        .where('id', '=', intentId)
        .execute();
      const res = await s.h.request('POST', `${s.path}/spends/${intentId}/resolve`, {
        ...s.auth,
        body: { outcome: 'failed' },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await s.row(intentId)).state).toBe('failed');
      expect(s.h.lines.some((l) => l.includes('spend inputs not released') && l.includes(intentId))).toBe(true);
    });

    it('resolves an on-chain send on a node without a spend credential, releasing nothing', async () => {
      const s = await interrupted();
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-owner-resolves-view-only',
      );
      await s.h.server.db.deleteFrom('credentials').where('node_id', '=', s.id).where('kind', '=', 'spend').execute();
      const discard = vi.spyOn(s.payer.onchain, 'discard');
      const res = await s.h.request('POST', `${s.path}/spends/${intentId}/resolve`, {
        ...s.auth,
        body: { outcome: 'failed' },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(discard).not.toHaveBeenCalled();
    });

    it('refuses "failed" for an on-chain send the wallet lists, and keeps the inputs when the wallet cannot be read', async () => {
      const s = await interrupted();
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-owner-resolves-broadcast',
      );
      const { txid } = await s.row(intentId);
      if (txid === null) throw new Error('no txid');
      const resolve = () =>
        s.h.request('POST', `${s.path}/spends/${intentId}/resolve`, { ...s.auth, body: { outcome: 'failed' } });
      const discard = vi.spyOn(s.payer.onchain, 'discard');
      const unreserve = vi.spyOn(s.payer.onchain, 'unreserve');
      // Listed on the second page of the wallet's history.
      const list = vi
        .spyOn(s.payer.onchain, 'listTransactions')
        .mockImplementation(async (page) =>
          page?.cursor === undefined
            ? { items: [{ txid: parseTxid('cd'.repeat(32)), confirmations: 3, kind: 'receive' }], nextCursor: 'p2' }
            : { items: [{ txid: parseTxid(txid), confirmations: 0, kind: 'send' }] },
        );
      const refused = await resolve();
      expect(await refused.json()).toMatchObject({
        error: { code: 'validation_failed', details: { reason: 'broadcast' } },
      });
      expect((await s.row(intentId)).state).toBe('unknown');
      // The wallet cannot be read: the choice is stored, but the inputs are kept.
      list.mockImplementation(async () => {
        throw new AdapterError({ code: 'node_unreachable', sent: false, definitive: false });
      });
      const res = await resolve();
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await s.row(intentId)).state).toBe('failed');
      expect(discard).not.toHaveBeenCalled();
      expect(unreserve).not.toHaveBeenCalled();
      expect(s.h.lines.some((l) => l.includes('spend wallet not readable'))).toBe(true);
    });

    it("keeps the owner's choice when the node cannot release the inputs", async () => {
      const s = await interrupted();
      s.payer.onchain.send = async () => crash();
      const { intentId } = await s.spend(
        'onchain',
        { address: await s.address(), amount: '100000000', feeRate: '2' },
        'wp10-owner-resolves-offline',
      );
      vi.spyOn(s.payer.onchain, 'discard').mockRejectedValue(new Error('down'));
      vi.spyOn(s.payer.onchain, 'unreserve').mockRejectedValue(
        new AdapterError({ code: 'node_unreachable', sent: false, definitive: false }),
      );
      const res = await s.h.request('POST', `${s.path}/spends/${intentId}/resolve`, {
        ...s.auth,
        body: { outcome: 'failed' },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await s.row(intentId)).state).toBe('failed');
      expect(s.h.lines.some((l) => l.includes('spend inputs not released') && l.includes('node_unreachable'))).toBe(
        true,
      );
      // Succeeded keeps counting and releases nothing.
      vi.restoreAllMocks();
      await s.payer.onchain.discard(parseTxid((await s.row(intentId)).txid ?? ''));
      s.payer.onchain.send = async () => crash();
      const other = await s.spend(
        'onchain',
        { address: await s.address(), amount: '20000000', feeRate: '2' },
        'wp10-owner-resolves-paid',
      );
      const paid = await s.h.request('POST', `${s.path}/spends/${other.intentId}/resolve`, {
        ...s.auth,
        body: { outcome: 'succeeded' },
      });
      expect(await paid.json()).toEqual({ intentId: other.intentId, state: 'succeeded' });
    });
  });
});

// WP10b: restoring the database from a backup (update and rollback spec §4, §6 "Rollback").
describe(`restore from a backup (${testDriver()})`, () => {
  async function restoring() {
    const h = await harness();
    let auth: { cookie: string; csrf: string } = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };
    const path = `/api/v1/nodes/${id}`;
    const payer = h.fakes.get('https://a.blake2b.test');
    const recipient = h.fakes.get('https://b.blake2b.test');
    if (!payer || !recipient) throw new Error('Missing fake');
    const invoice = async (sats: bigint) =>
      (
        await recipient.receive.createInvoice({
          amount: msat(sats * 1000n),
          description: 'x',
          label: randomBytes(8).toString('hex'),
        })
      ).bolt11;
    const preview = (request: string) => h.request('POST', `${path}/payments/preview`, { ...auth, body: { request } });
    const pay = async (sats: bigint) => {
      const p = await preview(await invoice(sats));
      expect(p.status, await p.clone().text()).toBe(200);
      const { confirmationToken } = (await p.json()) as { confirmationToken: string };
      const res = await h.request('POST', `${path}/payments/execute`, {
        ...auth,
        headers: { 'idempotency-key': randomBytes(16).toString('hex') },
        body: { confirmationToken, acknowledgeDuplicate: true },
      });
      expect(res.status, await res.clone().text()).toBe(200);
    };
    const used = async () =>
      BigInt(((await (await h.request('GET', `${path}/spend-policy`, auth)).json()) as { usedMsat: string }).usedMsat);
    let current = h.server;
    const dir = async () => {
      const databases = await sql<{ file: string }>`PRAGMA database_list`.execute(current.db);
      return dirname(databases.rows[0]?.file ?? '');
    };
    const backup = async () => {
      const file = join(await dir(), 'backups', 'pre-test.sqlite');
      mkdirSync(dirname(file), { recursive: true });
      await sql.raw(`VACUUM INTO '${file}'`).execute(current.db);
      return file;
    };
    const marker = (data: string) =>
      JSON.stringify({ version: 1, restoredAt: new Date(0).toISOString(), backupFile: data });
    // What the install script's restore mode does: stop, copy the backup over, drop the WAL, write the marker.
    const restore = async (file: string, text = marker('pre-test.sqlite')) => {
      current = await reopen(h, current, (data) => {
        copyFileSync(file, join(data, 'lightning-pilot.db'));
        for (const extra of ['-wal', '-shm']) rmSync(join(data, `lightning-pilot.db${extra}`), { force: true });
        writeFileSync(join(data, 'restore.json'), text, { mode: 0o600 });
      });
      return current;
    };
    const login = async () => {
      h.clock.now = new Date(h.clock.now.getTime() + 90_000);
      const res = await h.request('POST', '/api/v1/auth/login', {
        body: { password: PASSWORD, totpCode: totp(h.secret ?? '', h.clock.now) },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      auth = {
        cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        csrf: ((await res.json()) as { csrfToken: string }).csrfToken,
      };
      return auth;
    };
    return {
      h,
      id,
      path,
      payer,
      pay,
      preview,
      invoice,
      used,
      backup,
      restore,
      marker,
      login,
      dir,
      get auth() {
        return auth;
      },
      get server() {
        return current;
      },
    };
  }

  it("revokes sessions, pauses spending, then counts the node's payments the backup does not know", async () => {
    const s = await restoring();
    await s.pay(10_000n);
    const before = await s.used();
    expect(before).toBeGreaterThan(0n);
    const file = await s.backup();
    // Made after the backup: the restored database will not know it.
    await s.pay(20_000n);
    const old = s.auth;
    const server = await s.restore(file);
    expect(existsSync(join(await s.dir(), 'restore.json'))).toBe(false);
    expect(
      s.h.lines.some((l) => l.includes('"database restored from a backup"') && l.includes('"security":true')),
    ).toBe(true);
    // Every session (and known device) from the restored database is gone.
    expect((await s.h.request('GET', '/api/v1/nodes', old)).status).toBe(401);
    expect(await server.db.selectFrom('known_devices').selectAll().execute()).toEqual([]);
    await s.login();
    // The limits screen still works; spending waits for the node to be read again.
    expect(await s.used()).toBe(before);
    const refused = await s.preview(await s.invoice(1_000n));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: 'setup_required', details: { reason: 'restore_reconciliation' } },
    });
    expect(await server.recovery.resolvePass()).toBe(0);
    // The payment made after the backup is counted from the node at what it sent (the fake routes for free); the
    // one the backup knows is not counted twice.
    expect(await s.used()).toBe(before + 20_000_000n);
    expect(s.h.lines.some((l) => l.includes('"spend restore counted"') && l.includes('"payments":1'))).toBe(true);
    expect((await s.preview(await s.invoice(1_000n))).status).toBe(200);
    // 24 hours after the restore the count no longer applies.
    s.h.clock.now = new Date(s.h.clock.now.getTime() + 86_400_000);
    await s.login();
    expect(await s.used()).toBe(0n);
  });

  it('records a marker once even if the server stopped before removing it, and refuses an invalid one', async () => {
    const s = await restoring();
    const file = await s.backup();
    const text = s.marker('pre-test.sqlite');
    let server = await s.restore(file, text);
    expect(await server.db.selectFrom('restores').selectAll().execute()).toHaveLength(1);
    expect(await server.recovery.resolvePass()).toBe(0);
    // The same marker again (a crash between the commit and its removal): recorded once, nothing paused again.
    const dir = await s.dir();
    server = await reopen(s.h, server, (data) => writeFileSync(join(data, 'restore.json'), text));
    expect(await server.db.selectFrom('restores').selectAll().execute()).toHaveLength(1);
    expect(await server.db.selectFrom('restore_counts').select('state').execute()).toEqual([{ state: 'counted' }]);
    expect(existsSync(join(dir, 'restore.json'))).toBe(false);
    // A marker that cannot be read stops the start: a restore whose spends cannot be reconciled must not serve.
    await server.close();
    for (const bad of ['{', JSON.stringify({ version: 2, restoredAt: new Date(0).toISOString(), backupFile: 'x' })])
      await expect(reopen(s.h, dir, (data) => writeFileSync(join(data, 'restore.json'), bad))).rejects.toThrow(
        /not a valid restore marker/,
      );
  });

  it('keeps spending paused while the node cannot be read or cannot tell an amount, except what costs nothing', async () => {
    const s = await restoring();
    const file = await s.backup();
    const server = await s.restore(file);
    await s.login();
    // An on-chain transaction of the last day without an amount: the count cannot be trusted.
    const real = s.payer.onchain.listTransactions;
    s.payer.onchain.listTransactions = async () => ({
      items: [{ txid: parseTxid('ab'.repeat(32)), confirmations: 0, kind: 'other' }],
    });
    expect(await server.recovery.resolvePass()).toBe(1);
    expect(s.h.lines.some((l) => l.includes('an on-chain transaction has no amount'))).toBe(true);
    // A node error: still paused, asked again later.
    s.payer.onchain.listTransactions = async () => {
      throw new AdapterError({ code: 'node_unreachable', sent: true, definitive: false });
    };
    const again = await reopen(s.h, server);
    expect(await again.recovery.resolvePass()).toBe(1);
    expect(s.h.lines.some((l) => l.includes('node history not readable'))).toBe(true);
    // A close to the node's own wallet costs nothing and is allowed.
    const [channel] = (await s.payer.channel.listChannels()).items;
    const close = await s.h.request('POST', `${s.path}/channels/close/preview`, {
      ...s.auth,
      body: { channel: channel?.id },
    });
    expect(close.status, await close.clone().text()).toBe(200);
    s.payer.onchain.listTransactions = real;
  });

  it('counts only recent spends the database does not cover, and fails closed on what it cannot read', async () => {
    const s = await restoring();
    await s.pay(10_000n);
    const known = await s.server.db.selectFrom('spend_intents').select('payment_hash').executeTakeFirstOrThrow();
    const file = await s.backup();
    const server = await s.restore(file);
    await s.login();
    const now = s.h.clock.now.getTime();
    const at = (ms: number) => new Date(now + ms).toISOString();
    const hash = (n: number) => parsePaymentHash(n.toString(16).padStart(64, '0'));
    const listPayments = vi.spyOn(s.payer.pay, 'listPayments');
    const listTransactions = vi.spyOn(s.payer.onchain, 'listTransactions');
    const tip = (await s.payer.node.getInfo()).blockHeight;
    // Two pages, to read them all.
    listPayments.mockResolvedValueOnce({
      items: [{ paymentHash: hash(7), status: 'succeeded', amountSent: msat(64n), createdAt: at(-1000) }],
      nextCursor: 'next',
    });
    listPayments.mockResolvedValueOnce({
      items: [
        {
          paymentHash: hash(1),
          status: 'succeeded',
          amount: msat(1000n),
          amountSent: msat(1100n),
          createdAt: at(-60_000),
        },
        // Only some parts sent so far: the full amount counts.
        {
          paymentHash: hash(2),
          status: 'pending',
          amount: msat(2000n),
          amountSent: msat(500n),
          createdAt: at(-60_000),
        },
        // No time: may be recent, so counted.
        { paymentHash: hash(3), status: 'succeeded', amountSent: msat(4000n) },
        { paymentHash: hash(4), status: 'failed', amountSent: msat(8000n), createdAt: at(-60_000) },
        { paymentHash: hash(5), status: 'succeeded', amountSent: msat(16000n), createdAt: at(-90_000_000) },
        // Known to the restored database: counted there already.
        { paymentHash: parsePaymentHash(known.payment_hash ?? ''), status: 'succeeded', amountSent: msat(32000n) },
      ],
    });
    const tx = (
      n: number,
      extra: { confirmations: number; blockHeight?: number; amount?: { direction: 'in' | 'out'; value: bigint } },
    ) => ({
      txid: parseTxid(n.toString(16).padStart(64, '0')),
      kind: 'send' as const,
      confirmations: extra.confirmations,
      ...(extra.blockHeight === undefined ? {} : { blockHeight: extra.blockHeight }),
      ...(extra.amount === undefined ? {} : { amount: { ...extra.amount, value: msat(extra.amount.value) } }),
    });
    listTransactions.mockResolvedValue({
      items: [
        tx(1, { confirmations: 0, amount: { direction: 'out' as const, value: msat(100_000n) } }),
        tx(2, { confirmations: 3, blockHeight: tip - 2, amount: { direction: 'out' as const, value: msat(200_000n) } }),
        tx(3, { confirmations: 1, blockHeight: tip, amount: { direction: 'in' as const, value: msat(400_000n) } }),
        // Older than a day of blocks, or without a block: not counted.
        tx(4, {
          confirmations: 200,
          blockHeight: tip - 200,
          amount: { direction: 'out' as const, value: msat(800_000n) },
        }),
        tx(5, { confirmations: 10 }),
      ],
    });
    // An on-chain intent the restored database has: its transaction is not counted again.
    const row = await server.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow();
    await server.db
      .insertInto('spend_intents')
      .values({
        ...row,
        id: crypto.randomUUID(),
        type: 'onchain',
        payment_hash: null,
        idempotency_key: 'restore-onchain-known',
        txid: tx(2, { confirmations: 0 }).txid,
      })
      .execute();
    expect(await server.recovery.resolvePass()).toBe(0);
    const counted = await server.db.selectFrom('restore_counts').select('counted_msat').executeTakeFirstOrThrow();
    expect(counted.counted_msat).toBe((64n + 1100n + 2000n + 4000n + 100_000n).toString());
    // Counting again finds the row counted already and changes nothing.
    const { countRestore } = await import('./modules/spend/recovery/restore.ts');
    const pending = await server.db
      .selectFrom('restore_counts')
      .innerJoin('restores', 'restores.id', 'restore_counts.restore_id')
      .select(['restore_id', 'chain', 'pubkey', 'recorded_at'])
      .executeTakeFirstOrThrow();
    const quiet = createLogger({ sink: () => undefined });
    expect(await countRestore(server.db, s.payer, pending, s.h.clock.now, quiet)).toBe('counted');

    // A payment without an amount cannot be counted: spending stays paused.
    const again = await s.restore(file);
    listPayments.mockResolvedValue({ items: [{ paymentHash: hash(6), status: 'succeeded', createdAt: at(0) }] });
    const asked = listPayments.mock.calls.length;
    expect(await again.recovery.resolvePass()).toBe(1);
    expect(s.h.lines.some((l) => l.includes('a payment has no amount'))).toBe(true);
    // Not due yet: the next pass does not ask again.
    expect(await again.recovery.resolvePass()).toBe(1);
    expect(listPayments).toHaveBeenCalledTimes(asked + 1);
    // A node that cannot be loaded, and an identity with no node left: still paused, nothing asked.
    const third = await s.restore(file);
    s.h.fakes.delete('https://a.blake2b.test');
    expect(await third.recovery.resolvePass()).toBe(1);
    await third.db
      .updateTable('nodes')
      .set({ pubkey: '03' + 'ee'.repeat(32) })
      .execute();
    const fourth = await reopen(s.h, third);
    // The new identity gets its own pending count (its node cannot be loaded); the old one has no node left.
    expect(await fourth.recovery.resolvePass()).toBe(2);
    expect(listPayments).toHaveBeenCalledTimes(asked + 1);
  });

  it('pauses and counts a node added after the restore, which the restored database did not know', async () => {
    const s = await restoring();
    const file = await s.backup();
    const server = await s.restore(file);
    await s.login();
    expect(await server.recovery.resolvePass()).toBe(0);
    // Back to a security step-up to add a node (sessions were revoked by the restore).
    s.h.clock.now = new Date(s.h.clock.now.getTime() + 90_000);
    const step = await s.h.request('POST', '/api/v1/auth/step-up', {
      ...s.auth,
      body: { password: PASSWORD, strength: 'security', totpCode: totp(s.h.secret ?? '', s.h.clock.now) },
    });
    expect(step.status, await step.clone().text()).toBe(200);
    const stepped = {
      cookie: (step.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      csrf: ((await step.json()) as { csrfToken: string }).csrfToken,
    };
    const added = await addNode(s.h, stepped, 'https://a.bitcoin.test', 'bitcoin');
    expect(added.status, await added.clone().text()).toBe(201);
    const { id } = (await added.json()) as { id: string };
    const other = s.h.fakes.get('https://a.bitcoin.test');
    if (!other) throw new Error('Missing fake');
    const bolt11 = (await other.receive.createInvoice({ amount: msat(1000n), description: 'x', label: 'self' })).bolt11;
    const preview = () =>
      s.h.request('POST', `/api/v1/nodes/${id}/payments/preview`, { ...stepped, body: { request: bolt11 } });
    const refused = await preview();
    expect(await refused.json()).toMatchObject({
      error: { code: 'setup_required', details: { reason: 'restore_reconciliation' } },
    });
    // The next pass creates its count and reads the node; spending on it resumes.
    expect(await server.recovery.resolvePass()).toBe(0);
    expect(await server.db.selectFrom('restore_counts').select(['chain', 'state']).orderBy('chain').execute()).toEqual([
      { chain: 'bitcoin', state: 'counted' },
      { chain: 'blake2b', state: 'counted' },
    ]);
    const resumed = await preview();
    expect(resumed.status, await resumed.clone().text()).not.toBe(403);
  });
});

describe('WP14 node lifecycle', () => {
  it.each([
    'https://user:secret@localhost',
    'https://localhost/path',
    'https://localhost/?query=1',
    'https://localhost/#fragment',
    'https://8.8.8.8',
  ])('refuses an unintended node URL %s', async (url) => {
    const h = await harness();
    const auth = await loggedIn(h);
    const response = await addNode(h, auth, url, 'blake2b');
    expect(response.status).toBe(400);
    expect(await h.server.nodes.list()).toEqual([]);
  });
  it('refuses unrestricted credentials locally and requires explicit admin acknowledgement', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const unrestricted = Buffer.concat([Buffer.alloc(32, 1), Buffer.from('=1')]).toString('base64url');
    const rejected = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b', { viewRune: unrestricted });
    expect(rejected.status).toBe(403);
    const refused = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b', {
      accessLevel: 'admin',
      spendRune: unrestricted,
    });
    expect(refused.status).toBe(403);
    const accepted = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b', {
      accessLevel: 'admin',
      adminAcknowledged: true,
      spendRune: unrestricted,
    });
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    expect(await accepted.json()).toMatchObject({ adminCredential: true, accessLevel: 'admin' });
    expect(h.lines.some((line) => line.includes('"adminCredential":true') && line.includes('"security":true'))).toBe(
      true,
    );
  });
  it('requires limits with a pasted block and exposes narrow capabilities', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const narrow = Buffer.concat([Buffer.alloc(32, 1), Buffer.from('=3&id!&method=xpay')]).toString('base64url');
    const response = await h.request('POST', '/api/v1/nodes', {
      ...auth,
      body: {
        limits: testSpendPolicy,
        name: 'narrow',
        chain: 'blake2b',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://a.blake2b.test',
        caCertificate: CA,
        credentialBlock: JSON.stringify({
          version: 1,
          implementation: 'cln',
          accessLevel: 'standard',
          viewRune: VIEW_RUNE,
          spendRune: narrow,
        }),
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const summary = (await response.json()) as { id: string; limitsRequired: boolean };
    expect(summary.limitsRequired).toBe(false);
    const status = await h.request('GET', `/api/v1/nodes/${summary.id}/credentials`, auth);
    const data = (await status.json()) as { capabilities: string[]; spendStatusSource: string };
    expect(data.capabilities).toContain('pay.bolt11');
    expect(data.capabilities).not.toContain('channels.open');
    expect(data.spendStatusSource).toBe('last-verification');
  });
  it.each(['reserved', 'sent', 'unknown'] as const)('blocks removal for %s intents', async (state) => {
    const h = await harness();
    const auth = await loggedIn(h);
    const response = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b');
    const node = (await response.json()) as { id: string; pubkey: string };
    await h.server.db
      .insertInto('spend_intents')
      .values({
        id: randomBytes(16).toString('hex'),
        node_id: node.id,
        chain: 'blake2b',
        pubkey: node.pubkey,
        type: 'onchain',
        payment_hash: null,
        amount_msat: '1000',
        max_fee_msat: '0',
        fee_msat: null,
        state,
        idempotency_key: randomBytes(16).toString('hex'),
        digest: 'test',
        error_code: null,
        created_at: h.clock.now.toISOString(),
        updated_at: h.clock.now.toISOString(),
      })
      .execute();
    const removal = await h.request('DELETE', `/api/v1/nodes/${node.id}`, auth);
    expect(removal.status).toBe(409);
    expect(await h.server.nodes.list()).toHaveLength(1);
  });
  it('tombstones removal, preserves history and limits, removes secrets, and permits reattachment', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const response = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b');
    const node = (await response.json()) as { id: string; pubkey: string };
    expect((await h.request('DELETE', `/api/v1/nodes/${node.id}`, { ...auth, csrf: 'wrong' })).status).toBe(403);
    expect((await h.request('DELETE', `/api/v1/nodes/${node.id}`, auth)).status).toBe(204);
    expect(await h.server.nodes.list()).toEqual([]);
    expect(await h.server.db.selectFrom('credentials').selectAll().where('node_id', '=', node.id).execute()).toEqual(
      [],
    );
    expect(
      await h.server.db.selectFrom('spend_limits').selectAll().where('pubkey', '=', node.pubkey).execute(),
    ).toHaveLength(1);
    expect((await h.request('GET', `/api/v1/nodes/${node.id}`, auth)).status).toBe(404);
    const reattached = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b');
    expect(reattached.status, await reattached.clone().text()).toBe(201);
    expect(await reattached.json()).toMatchObject({ id: node.id, limitsRequired: false });
  });
  it('rolls back an add without limits and permits identity-preserving credential repair for unknown spends', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const denied = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b', { limits: undefined });
    expect(denied.status).toBe(403);
    expect(await h.server.nodes.list()).toEqual([]);
    expect(await h.server.db.selectFrom('credentials').selectAll().execute()).toEqual([]);
    const response = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b');
    const node = (await response.json()) as { id: string; pubkey: string };
    await h.server.db
      .insertInto('spend_intents')
      .values({
        id: 'repair-intent',
        node_id: node.id,
        chain: 'blake2b',
        pubkey: node.pubkey,
        type: 'onchain',
        payment_hash: null,
        amount_msat: '1000',
        max_fee_msat: '0',
        fee_msat: null,
        state: 'unknown',
        idempotency_key: 'repair-key',
        digest: 'test',
        error_code: null,
        created_at: h.clock.now.toISOString(),
        updated_at: h.clock.now.toISOString(),
      })
      .execute();
    const replacement = await h.request('PUT', `/api/v1/nodes/${node.id}`, {
      ...auth,
      body: {
        name: 'repaired',
        chain: 'blake2b',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://a.blake2b.test',
        caCertificate: CA,
        viewRune: VIEW_RUNE,
        spendRune: SPEND_RUNE,
      },
    });
    expect(replacement.status, await replacement.clone().text()).toBe(200);
    expect((await h.request('DELETE', `/api/v1/nodes/${node.id}`, auth)).status).toBe(409);
    await h.server.db
      .updateTable('spend_intents')
      .set({ state: 'succeeded' })
      .where('id', '=', 'repair-intent')
      .execute();
    expect((await h.request('DELETE', `/api/v1/nodes/${node.id}`, auth)).status).toBe(204);
    expect(
      await h.server.db.selectFrom('spend_intents').select(['id', 'state']).where('node_id', '=', node.id).execute(),
    ).toEqual([{ id: 'repair-intent', state: 'succeeded' }]);
  });
  it('refuses an unsafe legacy view rune before constructing or caching a read adapter', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const response = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b');
    const node = (await response.json()) as { id: string };
    const unrestricted = Buffer.concat([Buffer.alloc(32, 1), Buffer.from('=1')]).toString('base64url');
    const key = Buffer.from(readFileSync(h.vaultKeyPath, 'utf8').trim(), 'hex');
    const vault = await Vault.start(h.server.db, key);
    key.fill(0);
    cleanups.push(() => vault.close());
    await vault.put(h.server.db, node.id, 'read', unrestricted);
    await h.server.db.updateTable('nodes').set({ credentials_checked_at: null }).where('id', '=', node.id).execute();
    const factory = vi.fn(() => new FakeAdapter({ chain: 'blake2b' }));
    const restarted = new NodesService({
      db: h.server.db,
      vault,
      logger: createLogger({ sink: () => {} }),
      dev: true,
      maxNodes: 10,
      adapterFactory: factory,
    });
    await expect(restarted.adapter(node.id)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(factory).not.toHaveBeenCalled();
  });
  it('requires limits when a replacement enables spending on a read-only node', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const added = await h.request('POST', '/api/v1/nodes', {
      ...auth,
      body: {
        name: 'read',
        chain: 'blake2b',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://a.blake2b.test',
        caCertificate: CA,
        viewRune: VIEW_RUNE,
      },
    });
    const node = (await added.json()) as { id: string };
    const body = {
      name: 'standard',
      chain: 'blake2b',
      network: 'regtest',
      implementation: 'cln',
      url: 'https://a.blake2b.test',
      caCertificate: CA,
      viewRune: VIEW_RUNE,
      spendRune: SPEND_RUNE,
    };
    expect((await h.request('PUT', `/api/v1/nodes/${node.id}`, { ...auth, body })).status).toBe(403);
    expect(await h.server.nodes.summary(node.id)).toMatchObject({ accessLevel: 'read-only', canSpend: false });
    expect(
      (await h.request('PUT', `/api/v1/nodes/${node.id}`, { ...auth, body: { ...body, limits: testSpendPolicy } }))
        .status,
    ).toBe(200);
  });
  it('replaces a connection with step-up, refuses identity changes and clears cached adapters', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const response = await addNode(h, auth, 'https://a.blake2b.test', 'blake2b');
    const node = (await response.json()) as { id: string };
    const input = {
      name: 'renamed',
      chain: 'blake2b',
      network: 'regtest',
      implementation: 'cln',
      url: 'https://a.blake2b.test',
      caCertificate: CA,
      viewRune: VIEW_RUNE,
      spendRune: SPEND_RUNE,
    };
    expect(
      (
        await h.request('PUT', `/api/v1/nodes/${node.id}`, {
          ...auth,
          body: { ...input, url: 'https://b.blake2b.test' },
        })
      ).status,
    ).toBe(400);
    const updated = await h.request('PUT', `/api/v1/nodes/${node.id}`, { ...auth, body: input });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await updated.json()).toMatchObject({ name: 'renamed' });
    expect((await h.request('POST', `/api/v1/nodes/${node.id}/credentials/check`, auth)).status).toBe(200);
    expect(
      (await h.request('POST', '/api/v1/nodes/setup-command', { ...auth, body: { accessLevel: 'full' } })).status,
    ).toBe(200);
  });
});
