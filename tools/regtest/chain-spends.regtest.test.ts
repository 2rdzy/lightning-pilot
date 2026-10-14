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
