import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter, FakeNetwork } from '@lightning-pilot/adapter-kit';
import { msat, type EventCursor } from '@lightning-pilot/core';
import { loadConfig } from '../../config/config.ts';
import { createLogger } from '../../logging/logger.ts';
import { buildServer } from '../../server.ts';
import { setupForTest, tempDir, testDriver, writeVaultKey } from '../../testing.ts';
import { totp } from '../auth/totp/totp.ts';
import { EventBus } from './bus.ts';
import { EventStreams } from './streams.ts';
import { listen } from '../../http/listen.ts';
import { declaredPermissions } from '../../http/declare.ts';

const PASSWORD = 'Synthetic-Events-Password-123!';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function harness() {
  const t = tempDir();
  const key = writeVaultKey(t.dir);
  const { config } = loadConfig({
    readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: t.dir, vaultKey: key } }),
  });
  const world = new FakeNetwork();
  const fake = new FakeAdapter({ chain: 'blake2b', world });
  const other = new FakeAdapter({ chain: 'blake2b', world });
  fake.addChannel(other.pubkey);
  other.addChannel(fake.pubkey);
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
  const clock = { now: new Date('2026-10-15T08:00:00Z') };
  const options = {
    config,
    vaultKeyPath: key,
    dev: true,
    driver: testDriver(),
    logger,
    now: () => clock.now,
    scryptCost: { log2N: 10, r: 8, p: 1 },
    adapterFactory: () => fake,
    eventIntervalMs: 20,
    eventHeartbeatMs: 20,
    eventRetryMs: 5,
  };
  let server = await buildServer(options);
  cleanups.push(async () => {
    await server.close();
    t.cleanup();
  });
  const token = (JSON.parse(lines.find((line) => line.includes('"setupToken"')) ?? '{}') as { setupToken: string })
    .setupToken;
  const enrolled = await setupForTest(server.setup, token, PASSWORD, clock.now);
  let cookie = enrolled.reply.sessionCookie ?? '';
  let csrf = enrolled.reply.progress.session?.csrfToken ?? '';
  const session = await server.auth.session(cookie);
  if (!session) throw new Error('Missing test session');
  const request = (path = '/api/v1/events', headers: Record<string, string> = {}, method = 'GET', body?: unknown) =>
    Promise.resolve(
      server.app.request(path, {
        method,
        headers: {
          host: 'localhost',
          origin: 'https://localhost',
          cookie: `__Host-lp_session=${cookie}`,
          'x-csrf-token': csrf,
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const node = await server.nodes.add(
    {
      name: 'events',
      chain: 'blake2b',
      network: 'regtest',
      implementation: 'cln',
      url: 'https://fake.test',
      serverName: 'localhost',
      caCertificate: '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n',
      viewRune: 'view',
      spendRune: 'spend',
    },
    'r-test',
  );
  return {
    get server() {
      return server;
    },
    config,
    logger,
    fake,
    other,
    clock,
    session,
    cookie,
    request,
    node,
    reopen: async () => {
      await server.close();
      server = await buildServer(options);
    },
    step: async () => {
      const res = await request('/api/v1/auth/step-up', { 'content-type': 'application/json' }, 'POST', {
        strength: 'password',
        password: PASSWORD,
      });
      expect(res.status).toBe(200);
      cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? '';
      csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
    },
    totp: () => totp(enrolled.secret, clock.now),
  };
}
const readerOf = (response: Response) => {
  if (!response.body) throw new Error('Missing SSE response body');
  return response.body.getReader();
};
const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const chunk = await reader.read();
  return chunk.done ? undefined : new TextDecoder().decode(chunk.value);
};

describe('authenticated SSE lifecycle', () => {
  it('declares read permission, requires auth, and sends no-store SSE with replay', async () => {
    const h = await harness();
    expect((await h.request('/api/v1/events', { cookie: '' })).status).toBe(401);
    const first = h.server.events.bus.publish('block.new', { height: 1 });
    const second = h.server.events.bus.publish('block.new', { height: 2 });
    const res = await h.request('/api/v1/events', { 'last-event-id': first.id });
    expect(res.status).toBe(200);
    expect(declaredPermissions(h.server.app).get('GET /api/v1/events')).toBe('read');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const reader = readerOf(res);
    expect(await read(reader)).toContain(second.id);
    h.server.events.bus.publish('block.new', { height: 3 });
    expect(await read(reader)).toContain('"height":3');
    await reader.cancel();
  });
  it('enforces three streams and releases slots on cancellation', async () => {
    const h = await harness();
    const streams = await Promise.all([h.request(), h.request(), h.request()]);
    const refused = await h.request();
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('1');
    await streams[0]?.body?.cancel();
    const replacement = await h.request();
    expect(replacement.status).toBe(200);
    await replacement.body?.cancel();
    for (const stream of streams.slice(1)) await stream.body?.cancel();
  });
  it.each(['logout', 'revoked', 'expired'] as const)(
    'discards queued data and closes immediately on %s',
    async (reason) => {
      const h = await harness();
      const reader = readerOf(await h.request());
      expect(await read(reader)).toContain(': connected');
      h.server.events.bus.publish('block.new', { height: 123 });
      if (reason === 'expired') h.clock.now = new Date(h.clock.now.getTime() + 25 * 3600_000);
      await h.server.auth.sessions.end(h.session.handle, reason);
      expect(await read(reader)).toContain(`"reason":"${reason}"`);
      expect(await read(reader)).toBeUndefined();
    },
  );
  it('keeps a stream through cookie rotation; heartbeats never refresh last activity', async () => {
    const h = await harness();
    const before = await h.server.db
      .selectFrom('sessions')
      .select('last_seen_at')
      .where('handle', '=', h.session.handle)
      .executeTakeFirstOrThrow();
    const reader = readerOf(await h.request());
    await read(reader);
    await h.step();
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    expect(await read(reader)).toContain(': heartbeat');
    const after = await h.server.db
      .selectFrom('sessions')
      .select('last_seen_at')
      .where('handle', '=', h.session.handle)
      .executeTakeFirstOrThrow();
    expect(after.last_seen_at).toBe(before.last_seen_at);
    await h.server.auth.sessions.end(h.session.handle, 'logout');
    expect(await read(reader)).toContain('session.ending');
    expect(await read(reader)).toBeUndefined();
  });
  it('heartbeat catches expiry without activity and missing database sessions', async () => {
    const h = await harness();
    const reader = readerOf(await h.request());
    await read(reader);
    h.clock.now = new Date(h.clock.now.getTime() + 25 * 3600_000);
    expect(await read(reader)).toContain('"reason":"expired"');
    expect(await read(reader)).toBeUndefined();
  });
  it('bounds a slow client queue, replays a full history and releases the stream', async () => {
    const h = await harness();
    const reader = readerOf(await h.request());
    await read(reader);
    const first = h.server.events.bus.publish('block.new', { height: 1 });
    for (let i = 0; i < 1000; i++) h.server.events.bus.publish('block.new', { height: i + 2 });
    expect(await read(reader)).toBeUndefined();
    const replay = readerOf(await h.request('/api/v1/events', { 'last-event-id': first.id }));
    for (let i = 0; i < 1000; i++) expect(await read(replay)).toContain(`"height":${i + 2}`);
    await replay.cancel();
  });
  it('recognizes a new server epoch and closes streams at shutdown', async () => {
    const h = await harness();
    const first = h.server.events.bus.publish('block.new', { height: 1 });
    const old = readerOf(await h.request());
    await read(old);
    await h.reopen();
    expect(await read(old)).toBeUndefined();
    const reader = readerOf(await h.request('/api/v1/events', { 'last-event-id': first.id }));
    expect(await read(reader)).toContain('"reason":"restart"');
    await reader.cancel();
  });
  it('handles request abort and refuses new streams after service shutdown', async () => {
    const h = await harness();
    const signal = new AbortController();
    const streams = new EventStreams(h.server.auth, new EventBus());
    const stream = await streams.open(h.cookie, h.session.handle, signal.signal);
    signal.abort();
    expect((await stream.getReader().read()).done).toBe(true);
    await streams.stop();
    await expect(streams.open(h.cookie, h.session.handle, new AbortController().signal)).rejects.toMatchObject({
      code: 'busy',
    });
  });
});

describe('stream races and network transport', () => {
  it('cleans registration when request aborts before or during registration', async () => {
    const h = await harness();
    for (const alreadyAborted of [true, false]) {
      const signal = new AbortController();
      if (alreadyAborted) signal.abort();
      const opening = h.server.events.streams.open(h.cookie, h.session.handle, signal.signal);
      signal.abort();
      const stream = await opening;
      expect((await stream.getReader().read()).done).toBe(true);
    }
    const response = await h.request();
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
  it('closes on missing session at heartbeat and rejects failed registrations without leaking a slot', async () => {
    const h = await harness();
    await expect(
      h.server.events.streams.open('bad-cookie', h.session.handle, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    const reader = readerOf(await h.request());
    await read(reader);
    await h.server.db.deleteFrom('sessions').where('handle', '=', h.session.handle).execute();
    expect(await read(reader)).toBeUndefined();
  });
  it('delivers over a real HTTP socket and releases registration on client disconnect', async () => {
    const h = await harness();
    const listener = listen(h.server.app, { ...h.config, server: { ...h.config.server, port: 0 } }, h.logger);
    cleanups.push(async () => {
      await h.server.events.streams.stop();
      await listener.close();
    });
    const abort = new AbortController();
    const response = await fetch(`http://localhost:${await listener.port}/api/v1/events`, {
      headers: { cookie: `__Host-lp_session=${h.cookie}` },
      signal: abort.signal,
    });
    const reader = readerOf(response);
    expect(await read(reader)).toContain(': connected');
    h.server.events.bus.publish('block.new', { height: 987 });
    expect(await read(reader)).toContain('"height":987');
    abort.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(async () => {
      const connections = await Promise.all([h.request(), h.request(), h.request()]);
      for (const connection of connections) await connection.body?.cancel();
      expect(connections.map((c) => c.status)).toEqual([200, 200, 200]);
    });
  });
});

describe('node event ingestion', () => {
  it('publishes node and polled events, runs block identity checks and wakes authoritative recovery', async () => {
    const h = await harness();
    const events: string[] = [];
    const off = h.server.events.bus.subscribe((e) => events.push(e.type));
    const full = vi.spyOn(h.server.nodes.monitor, 'fullCheck');
    const wake = vi.spyOn(h.server.recovery, 'wake');
    h.server.events.workers.start();
    await vi.waitFor(() => expect(h.fake.calls).toContain('subscribe'));
    await vi.waitFor(() => expect(events).toContain('channel.updated'));
    const invoice = await h.fake.receive.createInvoice({ amount: msat(1000n), label: 'wp11', description: 'test' });
    await h.other.pay.pay({ bolt11: invoice.bolt11, maxFee: msat(1000n), label: 'test', retryForSeconds: 1 });
    const outgoing = await h.other.receive.createInvoice({
      amount: msat(2000n),
      label: 'outgoing',
      description: 'test',
    });
    await h.fake.pay.pay({ bolt11: outgoing.bolt11, maxFee: msat(1000n), label: 'outgoing', retryForSeconds: 1 });
    h.fake.mine();
    await vi.waitFor(() =>
      expect(events).toEqual(
        expect.arrayContaining([
          'invoice.paid',
          'payment.updated',
          'block.new',
          'peer.updated',
          'onchain.updated',
          'balances.updated',
          'fees.updated',
        ]),
      ),
    );
    expect(wake).toHaveBeenCalledWith(h.node.id, outgoing.paymentHash);
    expect(full).toHaveBeenCalledWith(h.node.id, 'block');
    await vi.waitFor(async () =>
      expect(await h.server.db.selectFrom('event_cursors').selectAll().execute()).toHaveLength(1),
    );
    off();
    await h.server.events.workers.stop();
  });
  it('persists the last handled cursor and resumes after restart without duplicating node events', async () => {
    const h = await harness();
    const subscribe = vi.spyOn(h.fake.events, 'subscribe');
    h.server.events.workers.start();
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
    h.fake.mine();
    await vi.waitFor(async () =>
      expect((await h.server.db.selectFrom('event_cursors').selectAll().execute())[0]?.cursor).toMatch(/^fake\./),
    );
    await h.server.events.workers.stop();
    const cursor = (await h.server.db.selectFrom('event_cursors').selectAll().executeTakeFirstOrThrow()).cursor;
    h.fake.mine();
    await h.reopen();
    const blocks: number[] = [];
    h.server.events.bus.subscribe((e) => {
      if (e.type === 'block.new') blocks.push(e.data.height);
    });
    h.server.events.workers.start();
    await vi.waitFor(() => expect(subscribe).toHaveBeenLastCalledWith(cursor, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(blocks).toEqual([h.fake.blockHeight]));
  });
  it('retries a failed subscription with its last cursor and aborts workers on removal', async () => {
    const h = await harness();
    const real = h.fake.events.subscribe;
    const cursors: (EventCursor | undefined)[] = [];
    vi.spyOn(h.fake.events, 'subscribe').mockImplementation((cursor, signal) => {
      cursors.push(cursor);
      if (cursors.length === 1)
        return {
          async *[Symbol.asyncIterator]() {
            throw new Error('offline');
            yield* [];
          },
        };
      return real(cursor, signal);
    });
    h.server.events.workers.start();
    await vi.waitFor(() => expect(cursors.length).toBeGreaterThan(1));
    h.fake.mine();
    await vi.waitFor(async () =>
      expect(await h.server.db.selectFrom('event_cursors').selectAll().execute()).toHaveLength(1),
    );
    // A node without spend intents can be removed without touching another module's invariants.
    await h.server.db.deleteFrom('credentials').where('node_id', '=', h.node.id).execute();
    await h.server.db.deleteFrom('nodes').where('id', '=', h.node.id).execute();
    await h.server.events.workers.reconcile();
    expect(await h.server.db.selectFrom('event_cursors').selectAll().execute()).toEqual([]);
  });
});

describe('event-triggered authoritative recovery', () => {
  it('bypasses matching backoff, serializes concurrent passes and coalesces wakes during a pass', async () => {
    const h = await harness();
    const invoice = await h.other.receive.createInvoice({
      amount: msat(1000n),
      label: 'recovery',
      description: 'test',
    });
    await h.server.db
      .insertInto('spend_intents')
      .values({
        id: 'event-recovery',
        node_id: h.node.id,
        chain: 'blake2b',
        pubkey: h.fake.pubkey,
        type: 'bolt11',
        payment_hash: invoice.paymentHash,
        amount_msat: '1000',
        max_fee_msat: '1000',
        fee_msat: null,
        state: 'unknown',
        idempotency_key: 'event-recovery-key',
        digest: 'a'.repeat(64),
        error_code: 'interrupted',
        created_at: h.clock.now.toISOString(),
        updated_at: h.clock.now.toISOString(),
      })
      .execute();
    expect(await h.server.recovery.resolvePass()).toBe(1);
    await h.fake.pay.pay({ bolt11: invoice.bolt11, maxFee: msat(1000n), label: 'event-recovery', retryForSeconds: 1 });
    expect(await h.server.recovery.resolvePass()).toBe(1);
    h.server.recovery.wake(h.node.id, 'b'.repeat(64));
    expect(await h.server.recovery.resolvePass()).toBe(1);
    const real = h.fake.pay.getPayment;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readPayment = vi.spyOn(h.fake.pay, 'getPayment').mockImplementation(async (hash) => {
      await gate;
      return real(hash);
    });
    h.server.recovery.wake(h.node.id, invoice.paymentHash);
    const first = h.server.recovery.resolvePass();
    expect(h.server.recovery.resolvePass()).toBe(first);
    await vi.waitFor(() => expect(readPayment).toHaveBeenCalledTimes(1));
    h.server.recovery.wake(h.node.id);
    h.server.recovery.wake(h.node.id, invoice.paymentHash);
    release();
    expect(await first).toBe(0);
    await vi.waitFor(async () =>
      expect((await h.server.db.selectFrom('spend_intents').select('state').executeTakeFirstOrThrow()).state).toBe(
        'succeeded',
      ),
    );
    await h.server.recovery.stop();
    h.server.recovery.wake(h.node.id);
  });
});

describe('snapshot polling and isolated failures', () => {
  it('reads all channel pages, detects disappearance, and continues after a snapshot failure', async () => {
    const h = await harness();
    const channels = await h.fake.channel.listChannels({ limit: 200 });
    const first = channels.items[0];
    const second = channels.items[1];
    if (!first || !second) throw new Error('Missing fixture channels');
    let removed = false;
    const pages = vi.spyOn(h.fake.channel, 'listChannels').mockImplementation(async (page) => {
      if (removed) return { items: [first] };
      return page?.cursor ? { items: [second] } : { items: [first], nextCursor: 'second' };
    });
    const events: string[] = [];
    h.server.events.bus.subscribe((e) => events.push(e.type));
    const peers = vi.spyOn(h.fake.peer, 'listPeers').mockRejectedValueOnce(new Error('temporary snapshot failure'));
    h.server.events.workers.start();
    await vi.waitFor(() => expect(pages).toHaveBeenCalledWith({ limit: 200, cursor: 'second' }));
    await vi.waitFor(() => expect(peers.mock.calls.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(events).toContain('peer.updated'));
    removed = true;
    await vi.waitFor(() => expect(events).toContain('reload'));
    await h.server.events.workers.stop();
  });
  it('bounds repeating pagination and resumes after the node read credential is restored', async () => {
    const h = await harness();
    const { AdapterError } = await import('@lightning-pilot/core');
    const real = h.fake.node.getInfo;
    let offline = true;
    vi.spyOn(h.fake.node, 'getInfo').mockImplementation(async () => {
      if (offline) throw new AdapterError({ code: 'node_credential_revoked', sent: false, definitive: true });
      return real();
    });
    const events: { type: string; data: unknown }[] = [];
    h.server.events.bus.subscribe((e) => events.push(e));
    const channels = vi.spyOn(h.fake.channel, 'listChannels').mockResolvedValue({ items: [], nextCursor: 'repeated' });
    const full = vi.spyOn(h.server.nodes.monitor, 'fullCheck');
    h.server.events.workers.start();
    h.server.events.workers.start();
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'node.reachability', data: { reachable: false, credential: 'revoked' } }),
      ),
    );
    offline = false;
    await vi.waitFor(() => expect(full).toHaveBeenCalledWith(h.node.id, 'reconnect'));
    await vi.waitFor(() => expect(channels.mock.calls.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(events.some((e) => e.type === 'balances.updated')).toBe(true));
    await h.server.events.workers.stop();
    await h.server.events.workers.reconcile();
    h.server.events.workers.start();
  });
  it('serializes reconciliation and restarts a worker when connection metadata changes', async () => {
    const h = await harness();
    const subscribe = vi.spyOn(h.fake.events, 'subscribe');
    const first = h.server.events.workers.reconcile();
    expect(h.server.events.workers.reconcile()).toBe(first);
    await first;
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    await h.server.db.updateTable('nodes').set({ server_name: 'new.localhost' }).where('id', '=', h.node.id).execute();
    await h.server.events.workers.reconcile();
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
    // Routine identity updates must not restart subscriptions.
    await h.server.db
      .updateTable('nodes')
      .set({ identity_checked_at: h.clock.now.toISOString() })
      .where('id', '=', h.node.id)
      .execute();
    await h.server.events.workers.reconcile();
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
});

describe('identity integration and shutdown registration', () => {
  it('publishes chain identity changes through the existing monitor hook', async () => {
    const h = await harness();
    const updates: unknown[] = [];
    h.server.events.bus.subscribe((event) => {
      if (event.type === 'chain_identity.updated') updates.push(event);
    });
    const facts = await h.fake.node.getInfo();
    vi.spyOn(h.fake.node, 'getInfo').mockResolvedValue({ ...facts, pubkey: h.other.pubkey });
    await h.server.nodes.monitor.fullCheck(h.node.id, 'other_node');
    expect(updates).toContainEqual(
      expect.objectContaining({
        type: 'chain_identity.updated',
        node: expect.objectContaining({ pubkey: h.fake.pubkey }),
        data: expect.objectContaining({ state: 'refused', failedCheck: 'node' }),
      }),
    );
  });
  it('waits for pending registrations at shutdown and closes the resulting transport', async () => {
    const h = await harness();
    const real = h.server.auth.sessions.registerStream.bind(h.server.auth.sessions);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(h.server.auth.sessions, 'registerStream').mockImplementation(async (cookie, close) => {
      await gate;
      return real(cookie, close);
    });
    const opening = h.server.events.streams.open(h.cookie, h.session.handle, new AbortController().signal);
    let stopped = false;
    const stopping = h.server.events.streams.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect((await (await opening).getReader().read()).done).toBe(true);
  });
});

it('requests reload and advances past an oversized advisory payload rather than retrying it forever', async () => {
  const h = await harness();
  const real = h.fake.events.subscribe;
  vi.spyOn(h.fake.events, 'subscribe').mockImplementation((cursor, signal) => ({
    async *[Symbol.asyncIterator]() {
      yield {
        event: {
          type: 'invoice.expired' as const,
          data: {
            paymentHash: (
              await h.fake.receive.createInvoice({ amount: msat(1000n), label: 'oversize', description: 'test' })
            ).paymentHash,
            label: 'x'.repeat(5000),
          },
        },
        cursor: 'fake.0',
      };
      yield* real(cursor, signal);
    },
  }));
  const types: string[] = [];
  h.server.events.bus.subscribe((event) => types.push(event.type));
  h.server.events.workers.start();
  await vi.waitFor(() => expect(types).toContain('reload'));
  await vi.waitFor(async () =>
    expect((await h.server.db.selectFrom('event_cursors').selectAll().executeTakeFirstOrThrow()).cursor).toBe('fake.0'),
  );
  h.fake.mine();
  await vi.waitFor(() => expect(types).toContain('block.new'));
});

it('HEAD returns headers without consuming a session stream slot', async () => {
  const h = await harness();
  for (let i = 0; i < 4; i++) {
    const response = await h.request('/api/v1/events', {}, 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.body).toBeNull();
  }
  const streams = await Promise.all([h.request(), h.request(), h.request()]);
  for (const stream of streams) await stream.body?.cancel();
  expect(streams.map((s) => s.status)).toEqual([200, 200, 200]);
});
