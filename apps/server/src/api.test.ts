// API tests over HTTP (in memory) with the fake adapter: request checks, setup, login, every route's permission,
// nodes, invoices and the spend flow, the error format, and that no secret reaches the log.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, FakeNetwork } from '@lightning-pilot/adapter-kit';
import { AdapterError, msat, type Chain, type Network } from '@lightning-pilot/core';
import { loadConfig } from './config/config.ts';
import { declaredPermissions } from './http/declare.ts';
import { openApiDocument } from './http/app.ts';
import { createLogger } from './logging/logger.ts';
import type { NodeConnection } from './modules/nodes/index.ts';
import { buildServer, type Server } from './server.ts';
import { tempDir, testDriver, writeVaultKey } from './testing.ts';
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
  server: Server;
  lines: string[];
  fakes: Map<string, FakeAdapter>;
  world: FakeNetwork;
  setupToken: () => string;
  request: (method: string, path: string, options?: RequestOptions) => Promise<Response>;
}

interface RequestOptions {
  body?: unknown;
  cookie?: string;
  csrf?: string;
  headers?: Record<string, string>;
}

async function harness(options: { dev?: boolean; webRoot?: string } = {}): Promise<Harness> {
  const { dir, cleanup } = tempDir();
  const vaultKey = writeVaultKey(dir);
  const { config } = loadConfig({
    readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: dir, vaultKey } }),
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
  const server = await buildServer({
    config,
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
  return { server, lines, fakes, world, setupToken, request };
}

async function loggedIn(h: Harness) {
  expect(
    (await h.request('POST', '/api/v1/setup', { body: { token: h.setupToken(), password: PASSWORD } })).status,
  ).toBe(204);
  const res = await h.request('POST', '/api/v1/auth/login', { body: { password: PASSWORD } });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return { cookie, csrf: csrfToken, setCookie };
}

async function addNode(h: Harness, auth: { cookie: string; csrf: string }, url: string, chain: Chain, extra = {}) {
  return h.request('POST', '/api/v1/nodes', {
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
    const bad = await h.request('POST', '/api/v1/setup', { body: { token: 'AAAA-BBBB', password: PASSWORD } });
    expect(await errorCode(bad)).toBe('setup_token_invalid');
    const weak = await h.request('POST', '/api/v1/setup', { body: { token: h.setupToken(), password: 'short' } });
    expect(await errorCode(weak)).toBe('validation_failed');
    const ok = await h.request('POST', '/api/v1/setup', {
      body: { token: h.setupToken().toLowerCase(), password: PASSWORD },
    });
    expect(ok.status).toBe(204);
    expect(
      (await h.request('POST', '/api/v1/setup', { body: { token: h.setupToken(), password: PASSWORD } })).status,
    ).toBe(404);
    expect(await (await h.request('GET', '/api/v1/setup')).json()).toEqual({ setupRequired: false });
  });

  it('logs in with a __Host- session cookie and requires the CSRF token', async () => {
    const h = await harness();
    await h.request('POST', '/api/v1/setup', { body: { token: h.setupToken(), password: PASSWORD } });
    expect(
      await errorCode(await h.request('POST', '/api/v1/auth/login', { body: { password: 'Wrong-password-1' } })),
    ).toBe('login_failed');
    const res = await h.request('POST', '/api/v1/auth/login', { body: { password: PASSWORD } });
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
    const res = await h.request('POST', '/api/v1/auth/login', { cookie: auth.cookie, body: { password: PASSWORD } });
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
    expect(p.cost).toEqual({ amount: '21000', maxFee: '5000', total: '26000' });

    const execute = (token: string, key: string, a = auth) =>
      h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
        ...a,
        body: { confirmationToken: token },
        headers: { 'idempotency-key': key },
      });
    const missingKey = await h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
      ...auth,
      body: { confirmationToken: p.confirmationToken },
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
    const res2 = await h.request('POST', '/api/v1/auth/login', { body: { password: PASSWORD } });
    const other = {
      cookie: (res2.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      csrf: ((await res2.json()) as { csrfToken: string }).csrfToken,
    };
    const res = await h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
      ...other,
      body: { confirmationToken: p.confirmationToken },
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
        body: { confirmationToken: p.confirmationToken },
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

  it('records an unclear outcome as unknown and blocks further spends on the node', async () => {
    const h = await harness();
    const auth = await loggedIn(h);
    const { id } = (await (await addNode(h, auth, 'https://a.blake2b.test', 'blake2b')).json()) as { id: string };
    const other = h.fakes.get('https://b.blake2b.test');
    const preview = async () =>
      (await (
        await h.request('POST', `/api/v1/nodes/${id}/payments/preview`, {
          ...auth,
          body: {
            request: (await other?.receive.createInvoice({ amount: msat(1_000n), description: 'x', label: 'x' }))
              ?.bolt11,
          },
        })
      ).json()) as { confirmationToken: string };
    const execute = (token: string) =>
      h.request('POST', `/api/v1/nodes/${id}/payments/execute`, {
        ...auth,
        body: { confirmationToken: token },
        headers: { 'idempotency-key': 'key-' + randomBytes(12).toString('hex') },
      });
    const first = await preview();
    h.fakes
      .get('https://a.blake2b.test')
      ?.failNext(new AdapterError({ code: 'node_unreachable', sent: true, definitive: false }));
    const res = await execute(first.confirmationToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe('unknown');
    expect(await errorCode(await execute((await preview()).confirmationToken))).toBe('spend_unknown');
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
        body: { confirmationToken: p.confirmationToken },
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
        body: { confirmationToken: token },
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
  it('refuses a vault key that does not match the database', async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    const start = async (key: Buffer) => {
      const vaultKey = writeVaultKey(dir, key);
      const { config } = loadConfig({
        readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: dir, vaultKey } }),
      });
      return buildServer({
        config,
        vaultKeyPath: vaultKey,
        dev: true,
        logger,
        driver: testDriver(),
        scryptCost: { log2N: 10, r: 8, p: 1 },
      });
    };
    const first = await start(randomBytes(32));
    const token = (JSON.parse(lines.find((l) => l.includes('"setupToken"')) ?? '{}') as { setupToken: string })
      .setupToken;
    await first.auth.completeSetup(token, PASSWORD, 'r-test');
    await first.close();
    await expect(start(randomBytes(32))).rejects.toThrow(/does not match this database/);
  });
});
