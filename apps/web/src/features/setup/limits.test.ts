import { expect, it } from 'vitest';
import type { SetupLimits } from '@lightning-pilot/core';
import { limitsInOrder } from './limits.ts';

const base: SetupLimits = {
  maxPerPayment: '100',
  max24h: '200',
  stepUpAbove: '50',
  maxFeeRate: '3',
  maxFeeSharePercent: 5,
  maxRoutingFeeSharePercent: 1,
  routingFeeAllowance: '10',
};

it('accepts limits that can all take effect, including explicit no-limit choices', () => {
  for (const change of [
    {},
    { maxPerPayment: '200', stepUpAbove: '200' },
    { maxPerPayment: null, stepUpAbove: '200' },
    { maxPerPayment: null, max24h: null, stepUpAbove: '999999' },
    { stepUpAbove: null },
  ])
    expect(limitsInOrder({ ...base, ...change })).toBe(true);
});

it('refuses a per-payment cap above the 24-hour cap and a step-up threshold above its cap', () => {
  for (const change of [
    { maxPerPayment: '201' },
    { stepUpAbove: '101' },
    { maxPerPayment: null, stepUpAbove: '201' },
    // Compared as integers, not as text.
    { maxPerPayment: '99', stepUpAbove: '100' },
  ])
    expect(limitsInOrder({ ...base, ...change })).toBe(false);
});
