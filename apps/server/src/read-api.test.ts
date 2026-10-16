// API tests of the WP14b read routes over HTTP (in memory) with the fake adapter: permission, CSRF and Origin on the
// POST, validation, paging bounds and cursors, the error format, capability checks against the stored view scope,
// the chain identity check before an address is handed out, and that no preimage leaves through these routes.
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, FakeNetwork } from '@lightning-pilot/adapter-kit';
import { AdapterError, msat, type Chain } from '@lightning-pilot/core';
import { loadConfig } from './config/config.ts';
import { createLogger } from './logging/logger.ts';
import { totp } from './modules/auth/totp/totp.ts';
import type { NodeConnection } from './modules/nodes/index.ts';
import { buildServer, type Server } from './server.ts';
import { setupForTest, tempDir, testDriver, testRune, testSpendPolicy, writeVaultKey } from './testing.ts';

const PASSWORD = 'Correct-horse-9-battery';
const CA = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const URLS: Record<string, Chain> = {
  'https://127.0.0.1:3010': 'blake2b',
  'https://127.0.0.1:3011': 'blake2b',
  'https://127.0.0.1:3020': 'bitcoin',
};

// A view rune with only the commands WP14 requires (the narrowest it admits).
function narrowViewRune(): string {
  return Buffer.concat([
    Buffer.alloc(32, 3),
    Buffer.from('=7&id!&method=getinfo|method=getrawblockbyheight|method=checkrune'),
  ]).toString('base64url');
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Auth {
  cookie: string;
  csrf: string;
}

async function harness() {
  const { dir, cleanup } = tempDir();
  const vaultKey = writeVaultKey(dir);
  const { config } = loadConfig({
    readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: dir, vaultKey } }),
  });
  const lines: string[] = [];
  const world = new FakeNetwork();
  const fakes = new Map<string, FakeAdapter>();
  for (const [url, chain] of Object.entries(URLS)) fakes.set(url, new FakeAdapter({ chain, world }));
  const now = new Date();
  const server: Server = await buildServer({
    config,
    now: () => now,
    vaultKeyPath: vaultKey,
    dev: true,
    logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }),
    driver: testDriver(),
    scryptCost: { log2N: 10, r: 8, p: 1 },
    adapterFactory: (c: NodeConnection) => {
      const adapter = fakes.get(c.url);
      if (!adapter) throw new Error(`no fake at ${c.url}`);
      return adapter;
    },
  });
  const secrets = new Set([
    PASSWORD,
    readFileSync(vaultKey, 'utf8').trim(),
    testRune('read'),
    testRune('spend'),
    narrowViewRune(),
  ]);
  cleanups.push(async () => {
    await server.close();
    const log = lines.join('\n');
    for (const secret of secrets) expect(log).not.toContain(secret);
    cleanup();
  });
  const request = (method: string, path: string, auth?: Auth, body?: unknown, headers: Record<string, string> = {}) =>
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
  const token = (JSON.parse(lines.find((l) => l.includes('"setupToken"')) ?? '{}') as { setupToken: string })
    .setupToken;
  const setup = await setupForTest(server.setup, token, PASSWORD, now);
  const login = await request('POST', '/api/v1/auth/login', undefined, {
    password: PASSWORD,
    totpCode: totp(setup.secret, now),
  });
  expect(login.status).toBe(200);
  const first = {
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    csrf: ((await login.json()) as { csrfToken: string }).csrfToken,
  };
  const stepUp = await request('POST', '/api/v1/auth/step-up', first, {
    password: PASSWORD,
    strength: 'security',
    totpCode: totp(setup.secret, new Date(now.getTime() + 30_000)),
  });
  expect(stepUp.status).toBe(200);
  const auth: Auth = {
    cookie: (stepUp.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    csrf: ((await stepUp.json()) as { csrfToken: string }).csrfToken,
  };
  secrets.add(auth.csrf);
  const addNode = async (url: string, extra: Record<string, unknown> = {}) => {
    const res = await request('POST', '/api/v1/nodes', auth, {
      name: 'node',
      chain: URLS[url],
      network: 'regtest',
      implementation: 'cln',
      url,
      caCertificate: CA,
      viewRune: testRune('read'),
      spendRune: testRune('spend'),
      limits: testSpendPolicy,
      ...extra,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  return { server, request, auth, fakes, addNode, world, secrets };
}

const body = async <T>(res: Response, status = 200): Promise<T> => {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
};
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

const READ_ROUTES = [
  'info',
  'fees',
  'channels',
  'channels/closed',
  'peers',
  'payments',
  'invoices',
  'onchain/transactions',
  'onchain/utxos',
];

describe(`WP14b read API (${testDriver()})`, () => {
  it('serves every read route with the shared schemas and needs a session for each', async () => {
    const h = await harness();
    const id = await h.addNode('https://127.0.0.1:3010');
    for (const route of READ_ROUTES) {
      expect((await h.request('GET', `/api/v1/nodes/${id}/${route}`, h.auth)).status, route).toBe(200);
      const anonymous = await h.request('GET', `/api/v1/nodes/${id}/${route}`);
      expect(anonymous.status, route).toBe(401);
      expect(await code(anonymous)).toBe('unauthenticated');
    }
    const info = await body<{ features: string; addresses: string[]; capabilities: string[]; accessLevel: string }>(
      await h.request('GET', `/api/v1/nodes/${id}/info`, h.auth),
    );
    expect(info.addresses).toEqual([]);
    expect(info.features).toMatch(/^[0-9a-f]+$/);
    expect(info.accessLevel).toBe('standard');
    expect(info.capabilities).toEqual(expect.arrayContaining(['channels.list', 'onchain.utxos', 'receive.onchain']));
    const fees = await body<{ source: string; rates: Record<string, string> }>(
      await h.request('GET', `/api/v1/nodes/${id}/fees`, h.auth),
    );
    expect(fees.source).toBe('node');
    expect(Object.keys(fees.rates).sort()).toEqual(['economy', 'fastest', 'halfHour', 'hour', 'minimum']);
    const utxos = await body<{ items: { amount: string }[] }>(
      await h.request('GET', `/api/v1/nodes/${id}/onchain/utxos`, h.auth),
    );
    expect(utxos.items.length).toBeGreaterThan(0);
    expect(utxos.items[0]?.amount).toMatch(/^[0-9]+$/);
  });

  it('pages lists with the node cursor and bounds the limit and cursor', async () => {
    const h = await harness();
    const id = await h.addNode('https://127.0.0.1:3010');
    const fake = h.fakes.get('https://127.0.0.1:3010') as FakeAdapter;
    for (let i = 0; i < 3; i++)
      await fake.receive.createInvoice({ amount: msat(1000n), description: `n${i}`, label: `l${i}` });
    const first = await body<{ items: { label: string }[]; nextCursor?: string }>(
      await h.request('GET', `/api/v1/nodes/${id}/invoices?limit=2`, h.auth),
    );
    expect(first.items.map((i) => i.label)).toEqual(['l0', 'l1']);
    expect(first.nextCursor).toBeDefined();
    const second = await body<{ items: { label: string }[]; nextCursor?: string }>(
      await h.request('GET', `/api/v1/nodes/${id}/invoices?limit=2&cursor=${first.nextCursor ?? ''}`, h.auth),
    );
    expect(second.items.map((i) => i.label)).toEqual(['l2']);
    expect(second.nextCursor).toBeUndefined();
    for (const query of ['limit=0', 'limit=201', 'limit=two', 'cursor=', `cursor=${'x'.repeat(201)}`, 'sort=desc']) {
      const res = await h.request('GET', `/api/v1/nodes/${id}/payments?${query}`, h.auth);
      expect(res.status, query).toBe(400);
      expect(await code(res)).toBe('validation_failed');
    }
    // A cursor the adapter cannot read is a request error (adapter validation_failed, not sent), not a node error.
    const bad = await h.request('GET', `/api/v1/nodes/${id}/channels?cursor=nonsense`, h.auth);
    expect(bad.status).toBe(400);
    expect(await code(bad)).toBe('validation_failed');
  });

  it('finds one channel by short channel id, channel id or funding outpoint and keeps "closed" a list', async () => {
    const h = await harness();
    const id = await h.addNode('https://127.0.0.1:3010');
    const btc = await h.addNode('https://127.0.0.1:3020');
    const list = await body<{
      items: { id: string; shortChannelId?: string; fundingOutpoint: string; replayableOnOtherChain: boolean }[];
    }>(await h.request('GET', `/api/v1/nodes/${id}/channels`, h.auth));
    const channel = list.items[0];
    expect(channel).toBeDefined();
    // BLAKE2b channels without unified signatures can be replayed on the other chain; Bitcoin channels cannot.
    expect(channel?.replayableOnOtherChain).toBe(true);
    const bitcoin = await body<{ items: { replayableOnOtherChain: boolean }[] }>(
      await h.request('GET', `/api/v1/nodes/${btc}/channels`, h.auth),
    );
    expect(bitcoin.items.every((c) => !c.replayableOnOtherChain)).toBe(true);
    for (const ref of [channel?.shortChannelId, channel?.id, channel?.fundingOutpoint]) {
      const found = await body<{ id: string }>(
        await h.request('GET', `/api/v1/nodes/${id}/channels/${encodeURIComponent(ref ?? '')}`, h.auth),
      );
      expect(found.id).toBe(channel?.id);
    }
    const closed = await body<{ items: unknown[] }>(
      await h.request('GET', `/api/v1/nodes/${id}/channels/closed`, h.auth),
    );
    expect(closed.items).toEqual([]);
    const missing = await h.request('GET', `/api/v1/nodes/${id}/channels/1x1x1`, h.auth);
    expect(missing.status).toBe(404);
    expect(await code(missing)).toBe('not_found');
    expect((await h.request('GET', `/api/v1/nodes/${id}/channels/open`, h.auth)).status).toBe(400);
  });

  it('lists payments and invoices without preimages and answers 404 for unknown hashes', async () => {
    const h = await harness();
    const id = await h.addNode('https://127.0.0.1:3010');
    const alice = h.fakes.get('https://127.0.0.1:3010') as FakeAdapter;
    const bob = h.fakes.get('https://127.0.0.1:3011') as FakeAdapter;
    alice.addChannel(bob.pubkey);
    const invoice = await bob.receive.createInvoice({ amount: msat(5_000n), description: 'coffee', label: 'b1' });
    const paid = await alice.pay.pay({ bolt11: invoice.bolt11, maxFee: msat(1000n), label: 'p1', retryForSeconds: 5 });
    h.secrets.add(paid.preimage);
    const own = await alice.receive.createInvoice({ amount: msat(7_000n), description: 'mine', label: 'a1' });
    const payments = await h.request('GET', `/api/v1/nodes/${id}/payments`, h.auth);
    const paymentText = await payments.clone().text();
    expect(paymentText).not.toContain(paid.preimage);
    expect(paymentText).not.toContain('preimage');
    const listed = await body<{ items: { paymentHash: string; status: string }[] }>(payments);
    expect(listed.items).toContainEqual(
      expect.objectContaining({ paymentHash: paid.paymentHash, status: 'succeeded' }),
    );
    const one = await body<{ paymentHash: string }>(
      await h.request('GET', `/api/v1/nodes/${id}/payments/${paid.paymentHash}`, h.auth),
    );
    expect(one.paymentHash).toBe(paid.paymentHash);
    const inv = await body<{ paymentHash: string; description: string; status: string }>(
      await h.request('GET', `/api/v1/nodes/${id}/invoices/${own.paymentHash}`, h.auth),
    );
    expect(inv).toMatchObject({ paymentHash: own.paymentHash, description: 'mine', status: 'unpaid' });
    const unknown = 'ab'.repeat(32);
    for (const route of ['payments', 'invoices']) {
      const res = await h.request('GET', `/api/v1/nodes/${id}/${route}/${unknown}`, h.auth);
      expect(res.status, route).toBe(404);
      expect(await code(res)).toBe('not_found');
      expect((await h.request('GET', `/api/v1/nodes/${id}/${route}/xyz`, h.auth)).status).toBe(400);
    }
  });

  it('hands out a new address only with CSRF, a known Origin and a confirmed chain identity', async () => {
    const h = await harness();
    const id = await h.addNode('https://127.0.0.1:3010');
    const path = `/api/v1/nodes/${id}/onchain/address`;
    const created = await body<{ address: string; type: string; chain: string; network: string }>(
      await h.request('POST', path, h.auth, {}),
      201,
    );
    expect(created).toMatchObject({ type: 'p2wpkh', chain: 'blake2b', network: 'regtest' });
    expect(created.address).toMatch(/^bcrt1q/);
    const taproot = await body<{ address: string; type: string }>(
      await h.request('POST', path, h.auth, { type: 'p2tr' }),
      201,
    );
    expect(taproot.address).toMatch(/^bcrt1p/);
    expect((await h.request('POST', path, h.auth, { type: 'p2pkh' })).status).toBe(400);
    expect((await h.request('POST', path, h.auth, { extra: 1 })).status).toBe(400);
    const noCsrf = await h.request('POST', path, { cookie: h.auth.cookie, csrf: '' }, {});
    expect(noCsrf.status).toBe(403);
    expect(await code(noCsrf)).toBe('csrf_failed');
    const foreign = await h.request('POST', path, h.auth, {}, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(await code(foreign)).toBe('bad_origin');
    expect((await h.request('POST', path, undefined, {})).status).toBe(401);
    for (const [state, expected] of [
      ['waiting', 'chain_waiting'],
      ['refused', 'chain_refused'],
    ] as const) {
      await sql`UPDATE nodes SET identity_state = ${state} WHERE id = ${id}`.execute(h.server.db);
      const refused = await h.request('POST', path, h.auth, {});
      expect(refused.status, state).toBe(409);
      expect(await code(refused)).toBe(expected);
    }
  });

  it('answers capability_missing, not a revoked credential, when the stored view scope lacks a command', async () => {
    const h = await harness();
    const id = await h.addNode('https://127.0.0.1:3010', {
      viewRune: narrowViewRune(),
      spendRune: undefined,
      accessLevel: 'read-only',
      limits: undefined,
    });
    const fake = h.fakes.get('https://127.0.0.1:3010') as FakeAdapter;
    const before = fake.calls.length;
    for (const route of READ_ROUTES.filter((r) => r !== 'info')) {
      const res = await h.request('GET', `/api/v1/nodes/${id}/${route}`, h.auth);
      expect(res.status, route).toBe(409);
      expect(await code(res)).toBe('capability_missing');
    }
    const address = await h.request('POST', `/api/v1/nodes/${id}/onchain/address`, h.auth, {});
    expect(await code(address)).toBe('capability_missing');
    // Refused before any node call.
    expect(fake.calls.slice(before)).toEqual([]);
    const info = await body<{ capabilities: string[]; accessLevel: string }>(
      await h.request('GET', `/api/v1/nodes/${id}/info`, h.auth),
    );
    expect(info.accessLevel).toBe('read-only');
    expect(info.capabilities).not.toContain('channels.list');
    // A row admitted before scopes were stored (no methods, never checked) is left to the node to enforce.
    await sql`UPDATE nodes SET view_methods = '[]', credentials_checked_at = NULL WHERE id = ${id}`.execute(
      h.server.db,
    );
    expect((await h.request('GET', `/api/v1/nodes/${id}/peers`, h.auth)).status).toBe(200);
  });

  it('maps node errors and unknown nodes to the shared error format', async () => {
    const h = await harness();
    const id = await h.addNode('https://127.0.0.1:3010');
    const fake = h.fakes.get('https://127.0.0.1:3010') as FakeAdapter;
    fake.failNext(new AdapterError({ code: 'node_unreachable', sent: false, definitive: true }));
    const down = await h.request('GET', `/api/v1/nodes/${id}/peers`, h.auth);
    expect(down.status).toBe(502);
    const error = ((await down.json()) as { error: { code: string; message: string; requestId: string } }).error;
    expect(error.code).toBe('node_unreachable');
    expect(error.requestId).toMatch(/^r-/);
    const other = '0b6c4b8e-0000-4000-8000-000000000000';
    for (const route of READ_ROUTES) {
      const res = await h.request('GET', `/api/v1/nodes/${other}/${route}`, h.auth);
      expect(res.status, route).toBe(404);
    }
    expect((await h.request('GET', `/api/v1/nodes/not-a-uuid/channels`, h.auth)).status).toBe(400);
  });
});
