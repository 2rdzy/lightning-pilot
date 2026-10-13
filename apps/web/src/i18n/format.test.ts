import { describe, expect, it } from 'vitest';
import {
  browserLocale,
  COIN,
  decimalSeparator,
  formatCoins,
  formatDateTime,
  formatExactSats,
  formatInteger,
  formatSats,
  parseSatsInput,
  shortId,
} from './format.ts';

describe('formatting from the browser region (style guide §6a)', () => {
  it('takes the first valid browser language, else the fallback', () => {
    expect(browserLocale(['de-DE', 'en'])).toBe('de-DE');
    expect(browserLocale(['not a tag!', 'fr-FR'])).toBe('fr-FR');
    expect(browserLocale([])).toBe('en-US');
    expect(browserLocale(undefined, 'en-GB')).toBe('en-GB');
  });

  it('groups sats as the region does, from bigint msat without floating point', () => {
    const msat = 1_250_000_000n;
    expect(formatSats(msat, 'en-US')).toBe('1,250,000');
    expect(formatSats(msat, 'de-DE')).toBe('1.250.000');
    expect(formatSats(msat, 'fr-FR')).toBe('1\u202f250\u202f000');
    expect(formatSats(msat, 'de-CH')).toBe("1'250'000");
    expect(formatSats(msat, 'en-IN')).toBe('12,50,000');
    // Beyond 2^53 msat, still exact.
    expect(formatSats(2_100_000_000_000_000_000n, 'en-US')).toBe('2,100,000,000,000,000');
  });

  it('rounds sats down and shows the exact msat only when needed', () => {
    expect(formatSats(1_999n, 'en-US')).toBe('1');
    expect(formatExactSats(1_234_567n, 'en-US')).toBe('1,234.567');
    expect(formatExactSats(1_234_007n, 'de-DE')).toBe('1.234,007');
    expect(formatExactSats(5_000n, 'en-US')).toBeUndefined();
  });

  it('shows whole coins with 8 decimals and the region decimal separator', () => {
    expect(formatCoins(1_250_000_000n, 'en-US')).toBe('0.01250000');
    expect(formatCoins(1_250_000_000n, 'de-DE')).toBe('0,01250000');
    expect(formatCoins(123_456_789_012_345n, 'en-US')).toBe('1,234.56789012');
    expect(decimalSeparator('fr-FR')).toBe(',');
    expect(COIN.blake2b).toBe('XBT');
    expect(COIN.bitcoin).toBe('BTC');
  });

  it('accepts sats as digits with the region grouping, nothing else', () => {
    expect(parseSatsInput('25000', 'en-US')).toBe(25_000_000n);
    expect(parseSatsInput('25,000', 'en-US')).toBe(25_000_000n);
    expect(parseSatsInput(' 1.250 ', 'de-DE')).toBe(1_250_000n);
    expect(parseSatsInput('1\u202f250', 'fr-FR')).toBe(1_250_000n);
    expect(parseSatsInput("1'250", 'de-CH')).toBe(1_250_000n);
    expect(parseSatsInput('1.250', 'en-US')).toBeUndefined();
    expect(parseSatsInput('12.5', 'en-US')).toBeUndefined();
    expect(parseSatsInput('-5', 'en-US')).toBeUndefined();
    expect(parseSatsInput('', 'en-US')).toBeUndefined();
    expect(parseSatsInput('1e6', 'en-US')).toBeUndefined();
  });

  it('groups whole numbers such as block heights', () => {
    expect(formatInteger(961_902, 'en-US')).toBe('961,902');
    expect(formatInteger(961_902n, 'de-DE')).toBe('961.902');
  });

  it('formats dates and shortens ids', () => {
    expect(formatDateTime('2026-10-13T08:00:00Z', 'en-US')).toMatch(/2026/);
    expect(shortId('02e74fb6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4ac1d9e3')).toBe(
      '02e74fb6…4ac1d9e3',
    );
    expect(shortId('short')).toBe('short');
  });
});
