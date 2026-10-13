import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '@lightning-pilot/adapter-kit';
import { AdapterError, type Chain, type NodeAdapter, type NodeFacts } from '@lightning-pilot/core';
import { createLogger } from '../../../logging/logger.ts';
import { tempDir, testDb } from '../../../testing.ts';
import { IdentityMonitor, type IdentityUpdate } from './monitor.ts';
import { runIdentityCheck } from './check.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const unreachable = () => new AdapterError({ code: 'node_unreachable', sent: false, definitive: true });

// A fake node whose getInfo can be made to fail for good, or to report another version.
class TestNode {
  readonly fake: FakeAdapter;
  readonly adapter: NodeAdapter;
  down = false;
  version = 'fake';
  constructor(chain: Chain) {
    this.fake = new FakeAdapter({ chain });
    const getInfo = async (): Promise<NodeFacts> => {
      if (this.down) throw unreachable();
      return { ...(await this.fake.node.getInfo()), version: this.version };
    };
    const getTipHeader = async () => {
      if (this.down) throw unreachable();
      return this.fake.chain.getTipHeader();
    };
    this.adapter = { ...this.fake, implementation: 'cln', node: { getInfo }, chain: { getTipHeader } };
  }
  tipFetches(): number {
    return this.fake.calls.filter((c) => c === 'getTipHeader').length;
  }
}

async function setup(options: { intervalMs?: number } = {}) {
  const { dir, cleanup } = tempDir();
  const { db } = await testDb(dir);
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  const nodes = new Map<string, TestNode>();
  const updates: IdentityUpdate[] = [];
  const monitor = new IdentityMonitor({
    db,
    logger,
    load: async (id) => {
      const row = await db.selectFrom('nodes').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      const node = nodes.get(id);
      if (!node) throw new Error(`no node ${id}`);
      return { row, adapter: node.adapter };
    },
    onUpdate: (u) => updates.push(u),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    now: () => new Date('2026-10-13T00:00:00Z'),
  });
  cleanups.push(async () => {
    await monitor.stop();
    await db.destroy();
    cleanup();
  });

  // Adds a node as NodesService.add does: checked first, stored with its state, baseline recorded.
  async function add(id: string, chain: Chain, profile: Chain = chain): Promise<TestNode> {
    const node = new TestNode(chain);
    nodes.set(id, node);
    const { facts, identity } = await runIdentityCheck(node.adapter, profile, 'regtest', new Date());
    if (!facts) throw new Error('fake unreachable');
    await db
      .insertInto('nodes')
      .values({
        id,
        name: id,
        chain: profile,
        network: 'regtest',
        implementation: 'cln',
        url: `https://${id}.test`,
        ca_certificate: 'x',
        server_name: 'localhost',
        pubkey: facts.pubkey,
        identity_state: identity.state,
        identity_failed_check: identity.failedCheck ?? null,
        identity_detail: identity.detail ?? null,
        identity_checked_at: identity.checkedAt,
        created_at: '2026-10-13T00:00:00Z',
      })
      .execute();
    monitor.recordBaseline(id, facts);
    return node;
  }

  const stored = async (id: string) =>
    db.selectFrom('nodes').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  return { db, monitor, add, stored, updates, lines };
}

describe('IdentityMonitor: full check', () => {
  it.each(['blake2b', 'bitcoin'] as const)('confirms a %s node under its own profile', async (chain) => {
    const { monitor, add, stored } = await setup();
    await add('n1', chain);
    expect(await monitor.fullCheck('n1', 'start')).toMatchObject({ state: 'confirmed', profile: chain });
    expect((await stored('n1')).identity_state).toBe('confirmed');
  });

  it.each([
    ['blake2b', 'bitcoin'],
    ['bitcoin', 'blake2b'],
  ] as const)('refuses a %s node under the %s profile', async (chain, profile) => {
    const { monitor, add, stored } = await setup();
    await add('n1', chain, profile);
    expect(await monitor.fullCheck('n1', 'start')).toMatchObject({ state: 'refused', failedCheck: 'software' });
    expect((await stored('n1')).identity_failed_check).toBe('software');
  });

  it.each(['blake2b', 'bitcoin'] as const)(
    "refuses a %s node whose tip is the other chain's block (header)",
    async (chain) => {
      const { monitor, add } = await setup();
      const node = await add('n1', chain);
      const other = new FakeAdapter({ chain: chain === 'blake2b' ? 'bitcoin' : 'blake2b' });
      node.fake.tipOverride = (await other.chain.getTipHeader()).raw;
      expect(await monitor.fullCheck('n1', 'block')).toMatchObject({ state: 'refused', failedCheck: 'header' });
    },
  );

  it.each(['blake2b', 'bitcoin'] as const)('waits on a %s node that is below the fork or not synced', async (chain) => {
    const { monitor, add } = await setup();
    const node = await add('n1', chain);
    node.fake.blockHeight = 0;
    expect(await monitor.fullCheck('n1', 'block')).toMatchObject({ state: 'waiting', failedCheck: 'fork_height' });
    node.fake.blockHeight = 1000;
    node.fake.synced = false;
    expect(await monitor.fullCheck('n1', 'sync')).toMatchObject({ state: 'waiting', failedCheck: 'sync' });
  });

  it('refuses a node that cannot answer, and one that answers with another key', async () => {
    const { monitor, add, db } = await setup();
    const node = await add('n1', 'blake2b');
    node.down = true;
    expect(await monitor.fullCheck('n1', 'unreachable')).toMatchObject({
      state: 'refused',
      failedCheck: 'unreachable',
    });
    node.down = false;
    await db
      .updateTable('nodes')
      .set({ pubkey: '03' + '11'.repeat(32) })
      .where('id', '=', 'n1')
      .execute();
    expect(await monitor.fullCheck('n1', 'other_node')).toMatchObject({ state: 'refused', failedCheck: 'node' });
  });

  it('runs one full check at a time per node: simultaneous callers share it', async () => {
    const { monitor, add } = await setup();
    const node = await add('n1', 'blake2b');
    const before = node.tipFetches();
    const [a, b] = await Promise.all([monitor.fullCheck('n1', 'block'), monitor.fullCheck('n1', 'preview')]);
    expect(a).toEqual(b);
    expect(node.tipFetches() - before).toBe(1);
  });

  it('tells the listener only when the state or the failed check changes, and logs a refusal as a warning', async () => {
    const { monitor, add, updates, lines } = await setup();
    const node = await add('n1', 'blake2b');
    await monitor.fullCheck('n1', 'block');
    expect(updates).toHaveLength(0);
    node.fake.featuresOverride = '';
    await monitor.fullCheck('n1', 'version');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      nodeId: 'n1',
      node: { chain: 'blake2b', network: 'regtest', pubkey: node.fake.pubkey },
      previous: { state: 'confirmed' },
      state: { state: 'refused', failedCheck: 'software' },
    });
    expect(lines.some((l) => l.includes('"level":"warn"') && l.includes('chain identity refused'))).toBe(true);
    await monitor.fullCheck('n1', 'block');
    expect(updates).toHaveLength(1);
  });

  it('survives a listener that throws', async () => {
    const { dir, cleanup } = tempDir();
    const { db } = await testDb(dir);
    const lines: string[] = [];
    const node = new TestNode('blake2b');
    const monitor = new IdentityMonitor({
      db,
      logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }),
      load: async (id) => ({
        row: await db.selectFrom('nodes').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
        adapter: node.adapter,
      }),
      onUpdate: () => {
        throw new Error('listener broke');
      },
    });
    cleanups.push(async () => {
      await db.destroy();
      cleanup();
    });
    await db
      .insertInto('nodes')
      .values({
        id: 'n1',
        name: 'n1',
        chain: 'blake2b',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://n1.test',
        ca_certificate: 'x',
        server_name: 'localhost',
        pubkey: node.fake.pubkey,
        identity_state: 'waiting',
        identity_checked_at: '2026-10-13T00:00:00Z',
        created_at: '2026-10-13T00:00:00Z',
      })
      .execute();
    expect(await monitor.fullCheck('n1', 'start')).toMatchObject({ state: 'confirmed' });
    expect(lines.some((l) => l.includes('identity listener failed'))).toBe(true);
  });
});

describe('IdentityMonitor: polling', () => {
  it('fetches no block while nothing changed, and runs a full check on a new block, version or sync change', async () => {
    const { monitor, add } = await setup();
    const node = await add('n1', 'blake2b');
    const fetches = () => node.tipFetches();
    const start = fetches();
    await monitor.poll();
    expect(fetches()).toBe(start);
    node.fake.blockHeight += 1;
    await monitor.poll();
    expect(fetches()).toBe(start + 1);
    node.version = 'v26.06.10';
    await monitor.poll();
    expect(fetches()).toBe(start + 2);
    node.fake.synced = false;
    await monitor.poll();
    expect(fetches()).toBe(start + 3);
    await monitor.poll();
    expect(fetches()).toBe(start + 3);
  });

  it('refuses a node that stops answering, and needs a full pass to confirm it again after it reconnects', async () => {
    const { monitor, add, stored, updates } = await setup();
    const node = await add('n1', 'blake2b');
    node.down = true;
    await monitor.poll();
    expect((await stored('n1')).identity_failed_check).toBe('unreachable');
    // Still down: no new check, no new event.
    await monitor.poll();
    expect(updates).toHaveLength(1);
    node.down = false;
    // Back, but now on the wrong chain's software: the full pass refuses it.
    node.fake.featuresOverride = '';
    await monitor.poll();
    expect((await stored('n1')).identity_failed_check).toBe('software');
    node.fake.featuresOverride = undefined;
    node.fake.blockHeight += 1;
    await monitor.poll();
    expect((await stored('n1')).identity_state).toBe('confirmed');
    expect(updates.map((u) => u.state.failedCheck ?? u.state.state)).toEqual(['unreachable', 'software', 'confirmed']);
  });

  it('checks every node at start, then polls on its interval until stopped', async () => {
    const { monitor, add, stored, db } = await setup({ intervalMs: 10 });
    const a = await add('a', 'blake2b');
    await add('b', 'bitcoin', 'blake2b');
    await db.updateTable('nodes').set({ identity_state: 'waiting' }).execute();
    monitor.start();
    monitor.start(); // a second start is ignored
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await stored('a')).identity_state).toBe('confirmed');
    expect((await stored('b')).identity_state).toBe('refused');
    a.fake.blockHeight += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
    await monitor.stop();
    const calls = a.fake.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(a.fake.calls.length).toBe(calls);
  });

  it('logs a node it cannot load and goes on with the others', async () => {
    const { monitor, add, db, lines } = await setup();
    await add('a', 'blake2b');
    await db
      .insertInto('nodes')
      .values({
        id: 'ghost',
        name: 'ghost',
        chain: 'blake2b',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://ghost.test',
        ca_certificate: 'x',
        server_name: 'localhost',
        pubkey: '02' + '22'.repeat(32),
        identity_state: 'confirmed',
        identity_checked_at: '2026-10-13T00:00:00Z',
        created_at: '2026-10-13T00:00:00Z',
      })
      .execute();
    await monitor.poll();
    expect(lines.some((l) => l.includes('identity poll failed') && l.includes('ghost'))).toBe(true);
  });
});

describe('IdentityMonitor: before a spend preview', () => {
  it('returns the stored state without fetching a block when the node is unchanged', async () => {
    const { monitor, add, db } = await setup();
    const node = await add('n1', 'blake2b');
    const before = node.tipFetches();
    expect(await monitor.ensureFresh('n1')).toMatchObject({ state: 'confirmed' });
    // The stored state is the source of truth: a refusal recorded elsewhere is returned as is.
    await db.updateTable('nodes').set({ identity_state: 'refused', identity_failed_check: 'header' }).execute();
    expect(await monitor.ensureFresh('n1')).toMatchObject({ state: 'refused', failedCheck: 'header' });
    expect(node.tipFetches()).toBe(before);
  });

  it('runs a full check first after a new block, after an unreachable period, without a baseline, or for another key', async () => {
    const { monitor, add, db } = await setup();
    const node = await add('n1', 'blake2b');
    const first = node.tipFetches();
    node.fake.blockHeight += 1;
    node.fake.featuresOverride = '';
    expect(await monitor.ensureFresh('n1')).toMatchObject({ state: 'refused', failedCheck: 'software' });
    expect(node.tipFetches()).toBe(first + 1);

    node.fake.featuresOverride = undefined;
    node.down = true;
    expect(await monitor.ensureFresh('n1')).toMatchObject({ state: 'refused', failedCheck: 'unreachable' });
    node.down = false;
    expect(await monitor.ensureFresh('n1')).toMatchObject({ state: 'confirmed' });

    monitor.forget('n1');
    const fetches = node.tipFetches();
    expect(await monitor.ensureFresh('n1')).toMatchObject({ state: 'confirmed' });
    expect(node.tipFetches()).toBe(fetches + 1);

    await db
      .updateTable('nodes')
      .set({ pubkey: '03' + '11'.repeat(32) })
      .execute();
    expect(await monitor.ensureFresh('n1')).toMatchObject({ state: 'refused', failedCheck: 'node' });
  });

  it('waits for a full check that is already running', async () => {
    const { monitor, add } = await setup();
    const node = await add('n1', 'blake2b');
    node.fake.featuresOverride = '';
    const running = monitor.fullCheck('n1', 'block');
    expect(await monitor.ensureFresh('n1')).toMatchObject({ state: 'refused' });
    await running;
  });
});
