import { describe, expect, it } from 'vitest';
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
