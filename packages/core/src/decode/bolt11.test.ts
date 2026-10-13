import { describe, expect, it } from 'vitest';
import { bech32 } from '@scure/base';
import { Bolt11Error, readBolt11 } from './bolt11.ts';
import fixtures from './fixtures/regtest-invoices.json' with { type: 'json' };

describe('readBolt11', () => {
  it.each(fixtures.invoices)('reads $chain invoice of $amountMsat msat as the node decodes it', (fixture) => {
    const read = readBolt11(fixture.bolt11);
    expect(read.network).toBe('regtest');
    expect(read.paymentHash).toBe(fixture.paymentHash);
    expect(read.amount === undefined ? null : read.amount.toString()).toBe(fixture.amountMsat);
    expect(read.timestamp).toBe(fixture.timestamp);
    expect(read.expirySeconds).toBe(fixture.expiry);
    expect(read.expiresAt.getTime()).toBe((fixture.timestamp + fixture.expiry) * 1000);
  });

  it('accepts upper case and the lightning: scheme', () => {
    const fixture = fixtures.invoices[0];
    if (!fixture) throw new Error('no fixture');
    expect(readBolt11(`lightning:${fixture.bolt11.toUpperCase()}`).paymentHash).toBe(fixture.paymentHash);
  });

  it('refuses a damaged checksum, other strings and unknown prefixes', () => {
    const fixture = fixtures.invoices[0];
    if (!fixture) throw new Error('no fixture');
    const damaged = fixture.bolt11.slice(0, -1) + (fixture.bolt11.endsWith('q') ? 'p' : 'q');
    for (const bad of [damaged, '', 'hello', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 'lnxy1qqqq']) {
      expect(() => readBolt11(bad), bad).toThrow(Bolt11Error);
    }
  });
});

// Invoices built word by word: 7 timestamp words, the given fields, then a zero signature (readBolt11 does not check
// the signature).
function build(hrp: string, fields: number[][]): string {
  const timestamp = [0, 0, 0, 0, 0, 0, 1];
  return bech32.encode(hrp, [...timestamp, ...fields.flat(), ...new Array<number>(104).fill(0)], false);
}
const field = (tag: number, data: number[]) => [tag, Math.floor(data.length / 32), data.length % 32, ...data];
const hashField = (word = 0) => field(1, [...new Array<number>(51).fill(0), word]);

describe('readBolt11 limits', () => {
  it('returns the invoice as nodes accept it: lower case, no scheme', () => {
    const fixture = fixtures.invoices[0];
    if (!fixture) throw new Error('no fixture');
    expect(readBolt11(`Lightning:${fixture.bolt11.toUpperCase()}`).bolt11).toBe(fixture.bolt11.toLowerCase());
  });

  it('accepts 21 million coins and refuses more', () => {
    expect(readBolt11(build('lnbcrt21000000', [hashField()])).amount).toBe(2_100_000_000_000_000_000n);
    expect(() => readBolt11(build('lnbcrt21000001', [hashField()]))).toThrow(Bolt11Error);
    expect(() => readBolt11(build(`lnbcrt${'9'.repeat(40)}p`, [hashField()]))).toThrow(Bolt11Error);
  });

  it('refuses an expiry that cannot make a valid date, and accepts leading zero words', () => {
    expect(() => readBolt11(build('lnbcrt10u', [hashField(), field(6, new Array<number>(1023).fill(31))]))).toThrow(
      Bolt11Error,
    );
    // 2^31 seconds: one more than the limit.
    expect(() => readBolt11(build('lnbcrt10u', [hashField(), field(6, [2, 0, 0, 0, 0, 0, 0])]))).toThrow(Bolt11Error);
    const padded = readBolt11(build('lnbcrt10u', [hashField(), field(6, [0, 0, 0, 0, 0, 0, 0, 0, 3, 16])])); // 112
    expect(padded.expirySeconds).toBe(112);
    expect(padded.expiresAt.getTime()).toBe((1 + 112) * 1000);
  });

  it('refuses unknown prefixes, truncated fields, a missing payment hash and bad amounts', () => {
    expect(() => readBolt11(build('lnxyz10u', [hashField()]))).toThrow(Bolt11Error);
    expect(() => readBolt11(build('lnbcrt10u', [hashField(), [13, 0, 20, 1]]))).toThrow(Bolt11Error);
    expect(() => readBolt11(build('lnbcrt10u', [hashField(), [13, 0]]))).toThrow(Bolt11Error);
    expect(() => readBolt11(build('lnbcrt10u', [field(13, [1, 2])]))).toThrow(Bolt11Error);
    expect(() => readBolt11(build('lnbcrt015u', [hashField()]))).toThrow(Bolt11Error);
    expect(() => readBolt11(build('lnbcrt15p', [hashField()]))).toThrow(Bolt11Error);
    expect(() => readBolt11('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'.replace('bcrt', 'xx'))).toThrow(Bolt11Error);
  });

  it('throws only Bolt11Error, also for a payment hash with non-zero padding bits', () => {
    expect(() => readBolt11(build('lnbcrt10u', [hashField(3)]))).toThrow(Bolt11Error);
  });
});
