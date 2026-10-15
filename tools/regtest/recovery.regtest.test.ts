// Crash recovery on real nodes (spend policy §4, §6): a server process is killed with SIGKILL after the intent is
// committed, once before and once after the node call, for a payment, an on-chain send, a channel open and a channel
// close; the next start marks the intent unknown and resolves it from the node. Only channels this file opens are
// closed. LP_REGTEST_CHAIN selects the chain.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiSession, ok, type ApiSession } from './api-session.ts';
import { blockCount, cli, invoiceOn, isPaidOn, nodeUri, regtest, regtestChain, type RegtestChain } from './nodes.ts';

const selected = regtestChain();
if (!selected) throw new Error('set LP_REGTEST_CHAIN to blake2b or sha256d');
const chain: RegtestChain = selected;
const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

let session: ApiSession;
beforeAll(async () => {
  session = await apiSession(chain);
});
afterAll(async () => {
  await session.cleanup();
});

// Runs one spend in a separate server process that is killed at the given point; returns the idempotency key.
function crashDuring(
  s: ApiSession,
  job: { kind: string; method: string; body: Record<string, unknown>; at: 'before' | 'after' },
): string {
  const key = `crash-${job.at}-${randomBytes(8).toString('hex')}`;
  const child = spawnSync(
    process.execPath,
    [
      CHILD,
      JSON.stringify({
        dir: s.dir,
        vaultKey: s.vaultKey,
        cookie: s.auth.cookie,
        csrf: s.auth.csrf,
        nodeId: s.nodeId,
        key,
        ...job,
      }),
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  expect(child.signal, `${child.stdout}${child.stderr}`).toBe('SIGKILL');
  return key;
}

const intentOf = async (s: ApiSession, key: string) =>
  s.server.db
    .selectFrom('spend_intents')
    .select([
      'id',
      'state',
      'payment_hash',
      'fee_msat',
      'preimage',
      'error_code',
      'txid',
      'channel_id',
      'psbt_ciphertext',
    ])
    .where('idempotency_key', '=', key)
    .executeTakeFirstOrThrow();

async function waitFor(what: string, check: () => boolean, seconds = 60): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
// Mines blocks and waits until every CLN node has seen them.
async function mine(blocks: number): Promise<void> {
  regtest(chain, 'mine', String(blocks));
  const height = blockCount(chain);
  for (const node of ['cln-a', 'cln-b', 'cln-c'])
    await waitFor(
      `${node} at ${height}`,
      () => (cli(chain, node, 'getinfo') as { blockheight: number }).blockheight >= height,
    );
}
const channelOf = (channelId: string) =>
  (cli(chain, 'cln-a', 'listpeerchannels') as { channels: { channel_id?: string; state: string }[] }).channels.find(
    (c) => c.channel_id === channelId,
  );
const reservedCoins = () =>
  (cli(chain, 'cln-a', 'listfunds') as { outputs: { reserved: boolean }[] }).outputs.filter((o) => o.reserved).length;
const newAddress = () => (cli(chain, 'cln-b', 'newaddr') as { bech32: string }).bech32;
// Recovery as it runs some time after the crash (xpay's retry window, a channel negotiation).
const after = (ms: number) => ({ now: () => new Date(Date.now() + ms) });

describe(`crash recovery on ${chain}`, () => {
  it('BOLT11, killed after the node paid: unknown at start, then succeeded from the node record', async () => {
    await session.suspend();
    const bolt11 = invoiceOn(chain, 'cln-c', 21_000n, `crash-after-${Date.now()}`);
    const key = crashDuring(session, { kind: 'payments', method: 'pay.pay', body: { request: bolt11 }, at: 'after' });
    const server = await session.reopen();
    const marked = await intentOf(session, key);
    expect(marked.state).toBe('unknown');
    expect(isPaidOn(chain, 'cln-c', marked.payment_hash ?? '')).toBe(true);
    expect(await server.recovery.resolvePass()).toBe(0);
    const resolved = await intentOf(session, key);
    expect(resolved.state).toBe('succeeded');
    expect(resolved.preimage).toMatch(/^[0-9a-f]{64}$/);
  });

  it('BOLT11, killed before the node call: unknown at start, failed once xpay would have stopped', async () => {
    await session.suspend();
    const bolt11 = invoiceOn(chain, 'cln-c', 22_000n, `crash-before-${Date.now()}`);
    const key = crashDuring(session, { kind: 'payments', method: 'pay.pay', body: { request: bolt11 }, at: 'before' });
    let server = await session.reopen();
    const marked = await intentOf(session, key);
    expect(marked.state).toBe('unknown');
    // Inside xpay's retry window the missing record proves nothing.
    expect(await server.recovery.resolvePass()).toBe(1);
    expect((await intentOf(session, key)).state).toBe('unknown');
    server = await session.reopen({ now: () => new Date(Date.now() + 121_000) });
    expect(await server.recovery.resolvePass()).toBe(0);
    expect(await intentOf(session, key)).toMatchObject({ state: 'failed', error_code: 'not_on_node' });
    expect(isPaidOn(chain, 'cln-c', marked.payment_hash ?? '')).toBe(false);
  });

  it('on-chain, killed after the broadcast: succeeded, found in the wallet, fee from the sealed PSBT', async () => {
    await session.suspend();
    const key = crashDuring(session, {
      kind: 'onchain',
      method: 'onchain.send',
      body: { address: newAddress(), amount: '41000000', feeRate: '2' },
      at: 'after',
    });
    const server = await session.reopen();
    const marked = await intentOf(session, key);
    expect(marked).toMatchObject({ state: 'unknown', error_code: 'interrupted' });
    expect(marked.psbt_ciphertext).not.toBeNull();
    expect(await server.recovery.resolvePass()).toBe(0);
    const resolved = await intentOf(session, key);
    expect(resolved).toMatchObject({ state: 'succeeded', txid: marked.txid, psbt_ciphertext: null });
    expect(BigInt(resolved.fee_msat ?? '0')).toBeGreaterThan(0n);
    await mine(1);
  });

  it('on-chain, killed before the broadcast: failed after the retry window, inputs released', async () => {
    const reservedBefore = reservedCoins();
    await session.suspend();
    const key = crashDuring(session, {
      kind: 'onchain',
      method: 'onchain.send',
      body: { address: newAddress(), amount: '42000000', feeRate: '2' },
      at: 'before',
    });
    // `txprepare` reserved the inputs; nothing was broadcast.
    expect(reservedCoins()).toBeGreaterThan(reservedBefore);
    let server = await session.reopen();
    expect(await server.recovery.resolvePass()).toBe(1);
    server = await session.reopen(after(121_000));
    expect(await server.recovery.resolvePass()).toBe(0);
    expect(await intentOf(session, key)).toMatchObject({
      state: 'failed',
      error_code: 'not_sent',
      psbt_ciphertext: null,
    });
    expect(reservedCoins()).toBe(reservedBefore);
  });

  let channelId = '';
  it('channel open, killed after the node call: succeeded, the channel found by peer and capacity', async () => {
    const peer = nodeUri(chain, 'cln-c');
    await session.reopen();
    await ok(await session.request('POST', `/api/v1/nodes/${session.nodeId}/peers`, { uri: peer.uri }));
    await session.suspend();
    const key = crashDuring(session, {
      kind: 'channels/open',
      method: 'channel.openChannel',
      body: { peer: peer.pubkey, amount: '333000000', feeRate: '2' },
      at: 'after',
    });
    const server = await session.reopen();
    expect((await intentOf(session, key)).state).toBe('unknown');
    expect(await server.recovery.resolvePass()).toBe(0);
    const resolved = await intentOf(session, key);
    expect(resolved.state).toBe('succeeded');
    channelId = resolved.channel_id ?? '';
    expect(channelOf(channelId)?.state).toMatch(/AWAITING_LOCKIN/);
    expect(resolved.txid).toMatch(/^[0-9a-f]{64}$/);
    await mine(6);
    await waitFor('the channel to be normal', () => channelOf(channelId)?.state === 'CHANNELD_NORMAL');
  });

  it('channel open, killed before the node call: failed once a negotiation would have ended', async () => {
    const peer = nodeUri(chain, 'cln-c');
    await session.suspend();
    const key = crashDuring(session, {
      kind: 'channels/open',
      method: 'channel.openChannel',
      body: { peer: peer.pubkey, amount: '334000000', feeRate: '2' },
      at: 'before',
    });
    let server = await session.reopen(after(121_000));
    expect(await server.recovery.resolvePass()).toBe(1);
    server = await session.reopen(after(601_000));
    expect(await server.recovery.resolvePass()).toBe(0);
    expect(await intentOf(session, key)).toMatchObject({ state: 'failed', error_code: 'not_on_node' });
  });

  it('channel close, killed before and after the node call: failed while normal, then succeeded', async () => {
    expect(channelId).toMatch(/^[0-9a-f]{64}$/);
    await session.suspend();
    const before = crashDuring(session, {
      kind: 'channels/close',
      method: 'channel.closeChannel',
      body: { channel: channelId },
      at: 'before',
    });
    let server = await session.reopen(after(121_000));
    expect(await server.recovery.resolvePass()).toBe(0);
    expect(await intentOf(session, before)).toMatchObject({ state: 'failed', error_code: 'not_on_node' });
    expect(channelOf(channelId)?.state).toBe('CHANNELD_NORMAL');

    await session.suspend();
    const closed = crashDuring(session, {
      kind: 'channels/close',
      method: 'channel.closeChannel',
      body: { channel: channelId },
      at: 'after',
    });
    server = await session.reopen();
    expect(await server.recovery.resolvePass()).toBe(0);
    expect((await intentOf(session, closed)).state).toBe('succeeded');
    expect(channelOf(channelId)?.state).not.toBe('CHANNELD_NORMAL');
    await mine(1);
  });
});
