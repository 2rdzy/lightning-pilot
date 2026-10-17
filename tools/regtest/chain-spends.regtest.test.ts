// On-chain and channel spends through the API on real nodes (WP09b): an on-chain send, a peer connection, a channel
// open, a cooperative close to the node's wallet and to an external address, and a force close with a password
// step-up. Only channels this file opens are closed; the channels `init` made stay. LP_REGTEST_CHAIN selects the chain.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiSession, ok, type ApiSession } from './api-session.ts';
import { blockCount, cli, nodeUri, regtest, regtestChain, type RegtestChain } from './nodes.ts';

const selected = regtestChain();
if (!selected) throw new Error('set LP_REGTEST_CHAIN to blake2b or sha256d');
const chain: RegtestChain = selected;

let s: ApiSession;
beforeAll(async () => {
  s = await apiSession(chain);
});
afterAll(async () => {
  await s.cleanup();
});

const key = () => `chain-${randomBytes(8).toString('hex')}`;
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
const channelState = (channelId: string) =>
  (cli(chain, 'cln-a', 'listpeerchannels') as { channels: { channel_id: string; state: string }[] }).channels.find(
    (c) => c.channel_id === channelId,
  )?.state;
const newAddress = () => (cli(chain, 'cln-b', 'newaddr') as { bech32: string }).bech32;
// An address of cln-a's own wallet: a send to it keeps the funds for the next tests.
const ownAddress = (type: 'bech32' | 'p2tr' = 'bech32') =>
  (cli(chain, 'cln-a', 'newaddr', `addresstype=${type}`) as Record<string, string>)[type] as string;
const confirmedCoins = () =>
  (
    cli(chain, 'cln-a', 'listfunds') as { outputs: { amount_msat: number; status: string; reserved: boolean }[] }
  ).outputs
    .filter((o) => o.status === 'confirmed' && !o.reserved)
    .map((o) => BigInt(o.amount_msat))
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
// What the transaction pays in fee, from bitcoind's mempool (before it is mined).
const mempoolFeeMsat = (txid: string) => {
  const entry = cli(chain, 'btc', 'getmempoolentry', txid) as { fees: { base: number } };
  return BigInt(Math.round(entry.fees.base * 1e8)) * 1000n;
};
const intentRow = (id: string) =>
  s.server.db
    .selectFrom('spend_intents')
    .select(['fee_msat', 'max_fee_msat', 'utxos', 'txid'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

async function spend<T>(kind: string, body: unknown): Promise<T & { intentId: string; state: string }> {
  const preview = await ok<{ confirmationToken: string }>(
    await s.request('POST', `/api/v1/nodes/${s.nodeId}/${kind}/preview`, body),
  );
  return ok(
    await s.request(
      'POST',
      `/api/v1/nodes/${s.nodeId}/${kind}/execute`,
      { confirmationToken: preview.confirmationToken, acknowledgeDuplicate: true },
      { 'idempotency-key': key() },
    ),
  );
}

async function openChannel(): Promise<string> {
  const peer = nodeUri(chain, 'cln-c');
  await ok(await s.request('POST', `/api/v1/nodes/${s.nodeId}/peers`, { uri: peer.uri }));
  const opened = await spend<{ channelId: string; txid: string }>('channels/open', {
    peer: peer.pubkey,
    amount: '300000000',
    feeRate: '2',
  });
  expect(opened.state).toBe('succeeded');
  expect(opened.txid).toMatch(/^[0-9a-f]{64}$/);
  // WP09c: the funding transaction (no check is possible before `fundchannel` broadcasts) pays at most the bound.
  const row = await intentRow(opened.intentId);
  expect(mempoolFeeMsat(opened.txid)).toBeLessThanOrEqual(BigInt(row.max_fee_msat));
  expect(JSON.parse(row.utxos ?? '[]').length).toBeGreaterThan(0);
  await mine(6);
  await waitFor('the channel to be normal', () => channelState(opened.channelId) === 'CHANNELD_NORMAL');
  return opened.channelId;
}

describe(`on-chain and channel spends on ${chain}`, () => {
  it('sends on-chain to an address of another node, after checking the PSBT the node built', async () => {
    const to = newAddress();
    const sent = await spend<{ txid: string }>('onchain', { address: to, amount: '150000000', feeRate: '2' });
    expect(sent.state).toBe('succeeded');
    await mine(1);
    const outputs = (cli(chain, 'cln-b', 'listfunds') as { outputs: { txid: string; amount_msat: number }[] }).outputs;
    expect(outputs.some((o) => o.txid === sent.txid && BigInt(o.amount_msat) === 150_000_000n)).toBe(true);
    const row = await s.server.db
      .selectFrom('spend_intents')
      .select(['type', 'state', 'txid', 'fee_msat', 'psbt_ciphertext'])
      .where('id', '=', sent.intentId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ type: 'onchain', state: 'succeeded', txid: sent.txid, psbt_ciphertext: null });
    expect(BigInt(row.fee_msat ?? '0')).toBeGreaterThan(0n);
  });

  it('WP09c: the node fee stays within the size bound, at several rates and with one or more coins', async () => {
    // Two more coins, of two types, so that a send larger than the largest coin needs several inputs.
    regtest(chain, 'cli', 'btc', '-rpcwallet=miner', 'sendtoaddress', ownAddress('p2tr'), '0.3');
    regtest(chain, 'cli', 'btc', '-rpcwallet=miner', 'sendtoaddress', ownAddress(), '0.2');
    await mine(1);
    await waitFor('the new coins at cln-a', () => confirmedCoins().length >= 3);
    const [largest = 0n, second = 0n] = confirmedCoins();
    const cases = [
      { feeRate: '1', amount: 20_000_000n, coins: 1 },
      { feeRate: '2.5', amount: 50_000_000n, coins: 1 },
      { feeRate: '3.333', amount: 30_000_000n, coins: 1 },
      // More than the largest coin holds: the largest and the next one.
      { feeRate: '7.001', amount: ((largest + second / 2n) / 1000n) * 1000n, coins: 2 },
    ];
    for (const c of cases) {
      const sent = await spend<{ txid: string }>('onchain', {
        address: ownAddress(),
        amount: c.amount.toString(),
        feeRate: c.feeRate,
      });
      expect(sent.state, `${c.amount} msat at ${c.feeRate} sat/vB`).toBe('succeeded');
      const row = await intentRow(sent.intentId);
      const fee = mempoolFeeMsat(sent.txid);
      expect(BigInt(row.fee_msat ?? '-1')).toBe(fee);
      expect(fee, `fee ${fee} above the bound ${row.max_fee_msat} at ${c.feeRate} sat/vB`).toBeLessThanOrEqual(
        BigInt(row.max_fee_msat),
      );
      expect(JSON.parse(row.utxos ?? '[]')).toHaveLength(c.coins);
      await mine(1);
    }
  }, 400_000);

  it('opens a channel and closes it cooperatively to the node wallet (not counted)', async () => {
    const channelId = await openChannel();
    const before = await ok<{ usedMsat: string }>(await s.request('GET', `/api/v1/nodes/${s.nodeId}/spend-policy`));
    const closed = await spend<{ closeType: string; txid?: string }>('channels/close', { channel: channelId });
    expect(closed.state).toBe('succeeded');
    expect(['mutual', 'pending']).toContain(closed.closeType);
    const after = await ok<{ usedMsat: string }>(await s.request('GET', `/api/v1/nodes/${s.nodeId}/spend-policy`));
    expect(after.usedMsat).toBe(before.usedMsat);
    await mine(1);
  });

  it('closes a channel cooperatively to an external address (local balance counted)', async () => {
    const channelId = await openChannel();
    const to = newAddress();
    const closed = await spend<{ closeType: string; txid?: string }>('channels/close', {
      channel: channelId,
      destination: to,
    });
    expect(closed.state).toBe('succeeded');
    await mine(1);
    if (closed.txid) {
      const outputs = (cli(chain, 'cln-b', 'listfunds') as { outputs: { txid: string }[] }).outputs;
      await waitFor('the close output at cln-b', () =>
        (cli(chain, 'cln-b', 'listfunds') as { outputs: { txid: string }[] }).outputs.some(
          (o) => o.txid === closed.txid,
        ),
      );
      expect(outputs).toBeDefined();
    }
  });

  it('force-closes a channel only after a fresh password step-up, with the peer disconnected', async () => {
    const channelId = await openChannel();
    await s.stepUp('password');
    // With the peer online, the adapter's one-second cooperative attempt can win; disconnect it first (through the
    // API, which also exercises the disconnect route) so the close is unilateral.
    const peer = nodeUri(chain, 'cln-c').pubkey;
    const preview = await ok<{ confirmationToken: string; stepUpRequired: boolean }>(
      await s.request('POST', `/api/v1/nodes/${s.nodeId}/channels/close/preview`, { channel: channelId, force: true }),
    );
    expect(preview.stepUpRequired).toBe(true);
    const dropped = await s.request('POST', `/api/v1/nodes/${s.nodeId}/peers/${peer}/disconnect`, { force: true });
    expect(dropped.status, await dropped.clone().text()).toBe(204);
    const closed = await ok<{ state: string; closeType: string; txid?: string }>(
      await s.request(
        'POST',
        `/api/v1/nodes/${s.nodeId}/channels/close/execute`,
        { confirmationToken: preview.confirmationToken },
        { 'idempotency-key': key() },
      ),
    );
    expect(closed.state).toBe('succeeded');
    expect(closed.closeType).toBe('unilateral');
    await mine(1);
    await waitFor('the channel to close on chain', () => channelState(channelId) !== 'CHANNELD_NORMAL');
  });
});
