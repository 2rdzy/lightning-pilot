import { describe, expect, it } from 'vitest';
import { rateOf } from './chain.ts';

describe('rateOf', () => {
  it('keeps at most three decimals, rounding up, and refuses absurd node estimates', () => {
    expect(rateOf('5')).toBe('5');
    expect(rateOf('1.25')).toBe('1.25');
    expect(rateOf('1.2341')).toBe('1.235');
    expect(rateOf('1.2340')).toBe('1.234');
    expect(rateOf('0.0001')).toBe('0.001');
    expect(rateOf('2.000')).toBe('2');
    for (const bad of ['0', '0.000', 'fast', '-1', '1e3', '10000000', ''])
      expect(() => rateOf(bad), bad).toThrow('Invalid node fee estimate.');
  });
});
