import { describe, expect, it } from 'vitest';
import { parseJsonLossless } from './json.ts';

describe('parseJsonLossless', () => {
  it('keeps msat amounts above 2^53 exact', () => {
    const parsed = parseJsonLossless('{"amount_msat": 2100000000000000001, "nested": [{"fee_msat": 0}]}') as {
      amount_msat: bigint;
      nested: { fee_msat: bigint }[];
    };
    expect(parsed.amount_msat).toBe(2100000000000000001n);
    expect(parsed.nested[0]?.fee_msat).toBe(0n);
  });

  it('keeps ordinary numbers as numbers and large integers as bigint', () => {
    const parsed = parseJsonLossless('{"blockheight": 126, "big": 9007199254740993, "ratio": 0.5}') as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ blockheight: 126, big: 9007199254740993n, ratio: 0.5 });
  });

  it('refuses a fractional amount', () => {
    expect(() => parseJsonLossless('{"amount_msat": 1.5}')).toThrow(SyntaxError);
  });
});
