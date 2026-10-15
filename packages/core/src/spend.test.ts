import { expect, it } from 'vitest';
import { PaymentPreviewRequest, PaymentExecuteRequest } from './api.ts';
import { SpendPolicy } from './spend.ts';
const policy = {
  maxPerPayment: '100',
  max24h: '200',
  stepUpAbove: '50',
  maxFeeRate: '3.125',
  maxFeeSharePercent: 5,
  maxRoutingFeeSharePercent: 1,
  routingFeeAllowance: '10',
};
it('defaults fee exceed modes to refusal and validates policy ordering and canonical amounts', () => {
  expect(SpendPolicy.parse(policy).maxRoutingFeeMode).toBe('refuse');
  for (const change of [
    { maxPerPayment: '201' },
    { stepUpAbove: '101' },
    { maxPerPayment: '01' },
    { maxFeeRateMode: 'allow' },
    { max24h: null, maxPerPayment: null, stepUpAbove: '01' },
  ])
    expect(SpendPolicy.safeParse({ ...policy, ...change }).success).toBe(false);
  expect(SpendPolicy.safeParse({ ...policy, maxPerPayment: null, max24h: null, stepUpAbove: null }).success).toBe(true);
  expect(SpendPolicy.safeParse({ ...policy, maxPerPayment: null, stepUpAbove: '201' }).success).toBe(false);
});
it('bounds preview options and requires explicit boolean duplicate acknowledgment', () => {
  expect(PaymentPreviewRequest.safeParse({ request: 'x', amount: '-1' }).success).toBe(false);
  expect(PaymentExecuteRequest.safeParse({ confirmationToken: 'x', acknowledgeDuplicate: 'true' }).success).toBe(false);
  expect(PaymentPreviewRequest.parse({ request: ' x ', amount: '1', maxFee: '0' })).toEqual({
    request: 'x',
    amount: '1',
    maxFee: '0',
  });
});

it('checks on-chain and channel spend requests strictly', async () => {
  const { OnchainPreviewRequest, ChannelOpenPreviewRequest, ChannelClosePreviewRequest, PeerConnectRequest } =
    await import('./spend.ts');
  const peer = '02' + 'ab'.repeat(32);
  expect(OnchainPreviewRequest.safeParse({ address: 'bcrt1qxyz', amount: '12345000' }).success).toBe(true);
  for (const amount of ['0', '12345001', '1.5', '-1000'])
    expect(OnchainPreviewRequest.safeParse({ address: 'bcrt1qxyz', amount }).success).toBe(false);
  for (const feeRate of ['0', '0.000', '1.2345', '1e3', '10000000'])
    expect(OnchainPreviewRequest.safeParse({ address: 'a', amount: '1000', feeRate }).success).toBe(false);
  expect(OnchainPreviewRequest.safeParse({ address: 'a', amount: '1000', other: 1 }).success).toBe(false);
  expect(ChannelOpenPreviewRequest.safeParse({ peer, amount: '100000000', push: '1' }).success).toBe(true);
  expect(ChannelOpenPreviewRequest.safeParse({ peer: 'ab', amount: '100000000' }).success).toBe(false);
  expect(ChannelClosePreviewRequest.parse({ channel: '103x1x0' })).toEqual({ channel: '103x1x0', force: false });
  expect(ChannelClosePreviewRequest.safeParse({ channel: 'AB'.repeat(32) }).success).toBe(false);
  expect(PeerConnectRequest.safeParse({ uri: `${peer}@127.0.0.1:9735` }).success).toBe(true);
  expect(PeerConnectRequest.safeParse({ uri: 'short' }).success).toBe(false);
});

it('accepts only a settled outcome when the owner resolves a spend', async () => {
  const { SpendResolveRequest, SpendIntentParam, UnresolvedSpend } = await import('./spend.ts');
  expect(SpendResolveRequest.safeParse({ outcome: 'succeeded' }).success).toBe(true);
  expect(SpendResolveRequest.safeParse({ outcome: 'failed' }).success).toBe(true);
  for (const outcome of ['unknown', 'reserved', 'paid', undefined])
    expect(SpendResolveRequest.safeParse({ outcome }).success).toBe(false);
  expect(SpendResolveRequest.safeParse({ outcome: 'failed', force: true }).success).toBe(false);
  expect(SpendIntentParam.safeParse({ nodeId: 'x', intentId: crypto.randomUUID() }).success).toBe(false);
  const at = new Date(0).toISOString();
  const spend = { intentId: crypto.randomUUID(), type: 'onchain', amount: '1000', cost: '2000', reason: null };
  expect(UnresolvedSpend.safeParse({ ...spend, createdAt: at, updatedAt: at }).success).toBe(true);
  expect(UnresolvedSpend.safeParse({ ...spend, type: 'keysend', createdAt: at, updatedAt: at }).success).toBe(false);
  expect(UnresolvedSpend.safeParse({ ...spend, txid: 'AB', createdAt: at, updatedAt: at }).success).toBe(false);
});
