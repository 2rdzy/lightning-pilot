// The WP14b read routes against cln-a on the selected chain, through the real server and the view-only adapter:
// every route answers with the shared schemas, a channel is found by each of its identifiers, history records carry
// no preimage, a new address names the chain, and a narrow (but valid) view rune answers capability_missing.
import { afterAll, expect, it } from 'vitest';
import { apiSession, ok, type ApiSession } from './api-session.ts';
import { cli, creds, invoiceOn, profileOf, regtest, regtestChain } from './nodes.ts';

const chain = regtestChain();
if (!chain) throw new Error('set LP_REGTEST_CHAIN');
let session: ApiSession | undefined;
const createdIds: string[] = [];
afterAll(async () => {
  // Only the rune created by this test is revoked; the shared environment's credentials stay usable.
  for (const id of createdIds) regtest(chain, 'cli', 'cln-a', 'blacklistrune', id);
  await session?.cleanup();
});

interface Channel {
  id: string;
  shortChannelId?: string;
  fundingOutpoint: string;
  state: { group: string };
  replayableOnOtherChain: boolean;
  channelType: string[];
}

it('serves the read routes from a real node on the selected chain', async () => {
  session = await apiSession(chain);
  const s = session;
  const base = `/api/v1/nodes/${s.nodeId}`;

  const info = await ok<{ pubkey: string; addresses: string[]; capabilities: string[]; features: string }>(
    await s.request('GET', `${base}/info`),
  );
  expect(info.pubkey).toMatch(/^0[23][0-9a-f]{64}$/);
  // Regtest nodes announce nothing: their listen socket (binding) must not appear as an address.
  expect(info.addresses).toEqual([]);
  expect(info.capabilities).toEqual(expect.arrayContaining(['channels.list', 'peers', 'onchain.utxos']));
  const fees = await ok<{ source: string; rates: { minimum: string } }>(await s.request('GET', `${base}/fees`));
  expect(fees.source).toBe('node');
  expect(Number(fees.rates.minimum)).toBeGreaterThan(0);

  const channels = await ok<{ items: Channel[] }>(await s.request('GET', `${base}/channels?limit=200`));
  const normal = channels.items.find((c) => c.state.group === 'active');
  expect(normal?.shortChannelId).toBeDefined();
  // Observed 2026-10-16: every BLAKE2b regtest channel reports channel_type names static_remotekey/even,
  // anchors/even, unified_sigs/even (bit 514), so none is replayable; Bitcoin channels never are.
  expect(normal?.replayableOnOtherChain).toBe(false);
  if (chain === 'blake2b') expect(normal?.channelType).toContain('unified_sigs/even');
  for (const c of channels.items)
    expect(c.replayableOnOtherChain).toBe(chain === 'blake2b' && !c.channelType.includes('unified_sigs/even'));
  for (const ref of [normal?.shortChannelId, normal?.id, normal?.fundingOutpoint]) {
    const found = await ok<Channel>(await s.request('GET', `${base}/channels/${encodeURIComponent(ref ?? '')}`));
    expect(found.id).toBe(normal?.id);
  }
  const firstPage = await ok<{ items: Channel[]; nextCursor?: string }>(
    await s.request('GET', `${base}/channels?limit=1`),
  );
  expect(firstPage.items).toHaveLength(1);
  if (channels.items.length > 1) expect(firstPage.nextCursor).toBeDefined();
  await ok<{ items: unknown[] }>(await s.request('GET', `${base}/channels/closed`));

  const peers = await ok<{ items: { pubkey: string; connected: boolean }[] }>(await s.request('GET', `${base}/peers`));
  expect(peers.items.filter((p) => p.connected).length).toBeGreaterThanOrEqual(2);

  // A payment made through the spend module, then read back from the node's history.
  const preview = await ok<{ confirmationToken: string }>(
    await s.request('POST', `${base}/payments/preview`, {
      request: invoiceOn(chain, 'cln-b', 2_000_000n, `read-api-${Date.now()}`),
    }),
  );
  const paid = await ok<{ paymentHash: string; preimage: string }>(
    await s.request(
      'POST',
      `${base}/payments/execute`,
      { confirmationToken: preview.confirmationToken },
      { 'idempotency-key': `read-api-${Date.now()}-xxxxxxxx` },
    ),
  );
  const one = await s.request('GET', `${base}/payments/${paid.paymentHash}`);
  const oneText = await one.clone().text();
  expect(oneText).not.toContain(paid.preimage);
  expect(await ok<{ status: string }>(one)).toMatchObject({ status: 'succeeded' });
  const payments = await s.request('GET', `${base}/payments?limit=200`);
  expect(await payments.clone().text()).not.toContain('preimage');
  await ok<{ items: unknown[] }>(payments);

  const created = await ok<{ paymentHash: string }>(
    await s.request('POST', `${base}/invoices`, { amount: '1000', description: 'read api' }),
    201,
  );
  const invoice = await ok<{ status: string; description: string }>(
    await s.request('GET', `${base}/invoices/${created.paymentHash}`),
  );
  expect(invoice).toMatchObject({ status: 'unpaid', description: 'read api' });
  const invoices = await ok<{ items: unknown[] }>(await s.request('GET', `${base}/invoices?limit=5`));
  expect(invoices.items.length).toBeGreaterThan(0);

  const txs = await ok<{ items: { txid: string; confirmations: number }[] }>(
    await s.request('GET', `${base}/onchain/transactions?limit=10`),
  );
  expect(txs.items.length).toBeGreaterThan(0);
  const utxos = await ok<{ items: { outpoint: string }[] }>(await s.request('GET', `${base}/onchain/utxos`));
  expect(utxos.items.length).toBeGreaterThan(0);
  const address = await ok<{ address: string; type: string; chain: string }>(
    await s.request('POST', `${base}/onchain/address`, { type: 'p2tr' }),
    201,
  );
  expect(address).toMatchObject({ type: 'p2tr', chain: profileOf(chain) });
  expect(address.address).toMatch(/^bcrt1p/);

  // A narrow view rune (only what admission requires) is valid, but cannot list channels: capability_missing,
  // not node_credential_revoked.
  const narrow = cli(
    chain,
    'cln-a',
    'createrune',
    '-k',
    'restrictions=[["id!"],["method=getinfo","method=getrawblockbyheight","method=checkrune"]]',
  ) as {
    rune: string;
    unique_id: string;
  };
  createdIds.push(narrow.unique_id);
  const connection = creds(chain, 'cln-a', 'view');
  await ok(
    await s.request('PUT', base, {
      name: 'narrow',
      chain: profileOf(chain),
      network: 'regtest',
      implementation: 'cln',
      url: connection.url,
      caCertificate: connection.caCertificate,
      viewRune: narrow.rune,
      accessLevel: 'read-only',
    }),
  );
  const refused = await s.request('GET', `${base}/channels`);
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('capability_missing');
  await ok(await s.request('GET', `${base}/info`));
});
