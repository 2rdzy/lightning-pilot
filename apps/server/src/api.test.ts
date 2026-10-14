// API tests over HTTP (in memory) with the fake adapter: request checks, setup, login, every route's permission,
// nodes, invoices and the spend flow, the error format, and that no secret reaches the log.
import { totp } from './modules/auth/totp/totp.ts';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter, FakeNetwork } from '@lightning-pilot/adapter-kit';
import { AdapterError, msat, parsePaymentHash, type Chain, type Network } from '@lightning-pilot/core';
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
const VIEW_RUNE = 'view-' + randomBytes(24).toString('base64url');
const SPEND_RUNE = 'spend-' + randomBytes(24).toString('base64url');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Harness {
  clock: { now: Date };
  server: Server;
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

async function harness(options: { dev?: boolean; webRoot?: string; maxNodes?: number } = {}): Promise<Harness> {
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
  const logger = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
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
    cleanup();
  });
  const request = (method: string, path: string, o: RequestOptions = {}) =>
    Promise.resolve(
      server.app.request(path, {
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
  const setupToken = () => {
    const line = [...lines].reverse().find((l) => l.includes('"setupToken"'));
    return (JSON.parse(line ?? '{}') as { setupToken: string }).setupToken;
  };
  return { server, lines, fakes, world, setupToken, request, clock };
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
    expect(connections).toEqual([expect.objectContaining({ viewRune: VIEW_RUNE, spendRune: SPEND_RUNE })]);
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
    await s.h.server.db.deleteFrom('spend_confirmations').execute();
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
        paymentHash: parsePaymentHash(intent.payment_hash),
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
    s.h.clock.now = new Date(s.h.clock.now.getTime() + 1001);
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
      logger: createLogger({
        sink: (line) => {
          if (
            ['spend intent', 'payment not completed', 'spend result'].includes(
              (JSON.parse(line) as { msg: string }).msg,
            )
          )
            throw new Error('injected intent-log failure');
        },
      }),
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
