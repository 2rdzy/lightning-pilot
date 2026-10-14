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
