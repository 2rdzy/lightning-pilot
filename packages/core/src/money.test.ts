import { describe, expect, it } from 'vitest';
import { add, max, MoneyError, msat, MsatString, parseMsat, ppm, satToMsat, sub, toMsatString } from './money.ts';

describe('money', () => {
  it('round-trips amounts above 2^53 without loss', () => {
    const text = '2100000000000000000';
    expect(toMsatString(parseMsat(text))).toBe(text);
    expect(parseMsat('9007199254740993')).toBe(9007199254740993n);
  });

  it('refuses anything that is not a canonical decimal amount', () => {
    for (const bad of ['', '-1', '01', '1.5', '1e3', ' 1', '0x10', '1'.repeat(22)]) {
      expect(() => parseMsat(bad), bad).toThrow(MoneyError);
      expect(MsatString.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('refuses negative amounts and negative results', () => {
    expect(() => msat(-1n)).toThrow(MoneyError);
    expect(() => sub(msat(1n), msat(2n))).toThrow(MoneyError);
  });

  it('converts satoshi and adds exactly', () => {
    expect(satToMsat(21n)).toBe(21000n);
    expect(add(msat(1n), msat(2n), msat(3n))).toBe(6n);
  });

  it('rounds parts per million up', () => {
    expect(ppm(msat(1000n), 5000n)).toBe(5n);
    expect(ppm(msat(1n), 5000n)).toBe(1n);
    expect(ppm(msat(0n), 5000n)).toBe(0n);
  });
});

describe('money helpers', () => {
  it('subtracts and picks the larger amount', () => {
    expect(sub(msat(5n), msat(2n))).toBe(3n);
    expect(max(msat(1n), msat(2n))).toBe(2n);
    expect(max(msat(3n), msat(2n))).toBe(3n);
  });
});
