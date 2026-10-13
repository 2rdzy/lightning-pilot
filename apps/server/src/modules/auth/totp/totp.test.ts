import { describe, expect, it } from 'vitest';
import { generateTotpSecret, hotp, matchTotp, otpauthUri, totp } from './totp.ts';

// Independent fixture encoder: the RFCs specify ASCII keys, while provisioning uses Base32.
function base32(ascii: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const binary = [...Buffer.from(ascii)].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  return (binary.match(/.{1,5}/g) ?? []).map((chunk) => alphabet[parseInt(chunk.padEnd(5, '0'), 2)]).join('');
}
const secret = base32('12345678901234567890');

describe('HOTP and TOTP', () => {
  // https://www.rfc-editor.org/rfc/rfc4226#appendix-D
  it.each(
    ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'].map(
      (code, counter) => ({ code, counter }),
    ),
  )('matches RFC 4226 counter $counter', ({ code, counter }) => {
    expect(hotp(secret, BigInt(counter))).toBe(code);
  });

  // https://www.rfc-editor.org/rfc/rfc6238#appendix-B
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ] as const;
  it.each(vectors)('matches all RFC 6238 algorithms at %i seconds', (seconds, sha1, sha256, sha512) => {
    const now = new Date(seconds * 1000);
    expect(totp(secret, now, 'sha1', 8)).toBe(sha1);
    expect(totp(base32('12345678901234567890123456789012'), now, 'sha256', 8)).toBe(sha256);
    expect(totp(base32('1234567890123456789012345678901234567890123456789012345678901234'), now, 'sha512', 8)).toBe(
      sha512,
    );
  });

  it('generates independent 160-bit secrets in unpadded Base32', () => {
    const first = generateTotpSecret();
    expect(first).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(first);
    expect(hotp(first, 0n)).toMatch(/^\d{6}$/);
  });

  it('accepts only the current and adjacent counters', () => {
    const now = new Date(300_000);
    for (const counter of [9n, 10n, 11n]) expect(matchTotp(secret, hotp(secret, counter), now)).toBe(counter);
    for (const counter of [8n, 12n]) expect(matchTotp(secret, hotp(secret, counter), now)).toBeUndefined();
    expect(matchTotp(secret, hotp(secret, 0n), new Date(0))).toBe(0n);
  });

  it('rejects replay and rollback while permitting a later counter', () => {
    const now = new Date(300_000);
    for (const counter of [9n, 10n]) expect(matchTotp(secret, hotp(secret, counter), now, 10n)).toBeUndefined();
    expect(matchTotp(secret, hotp(secret, 11n), now, 10n)).toBe(11n);
    expect(matchTotp(secret, hotp(secret, 10n), now, 11n)).toBeUndefined();
  });

  it.each(['', '12345', '1234567', '12345a', ' 755224', '755224 ', '７５５２２４', '755224\n'])(
    'rejects malformed code %j',
    (code) => {
      expect(matchTotp(secret, code, new Date(0))).toBeUndefined();
    },
  );

  it.each(['', 'A', 'ABC', 'ABCDEF', 'MZ', 'my======', 'MY======', 'MY ', 'MY0', 'MY1'])(
    'rejects malformed secret %j',
    (invalid) => {
      expect(() => hotp(invalid, 0n)).toThrow('Invalid TOTP secret');
      expect(() => otpauthUri(invalid, 'Owner')).toThrow('Invalid TOTP secret');
    },
  );

  it('checks counter and time boundaries', () => {
    expect(() => hotp(secret, -1n)).toThrow('Invalid TOTP counter');
    expect(() => hotp(secret, 1n << 64n)).toThrow('Invalid TOTP counter');
    expect(hotp(secret, (1n << 64n) - 1n)).toMatch(/^\d{6}$/);
    expect(() => totp(secret, new Date(NaN))).toThrow('Invalid TOTP time');
    expect(() => totp(secret, new Date(-1))).toThrow('Invalid TOTP time');
    expect(totp(secret, new Date(29_999))).toBe(hotp(secret, 0n));
    expect(totp(secret, new Date(30_000))).toBe(hotp(secret, 1n));
  });

  it('rejects unsupported parameters even from untyped callers', () => {
    // @ts-expect-error deliberate runtime input validation
    expect(() => hotp(secret, 0n, 'md5')).toThrow('Invalid TOTP parameters');
    // @ts-expect-error deliberate runtime input validation
    expect(() => hotp(secret, 0n, 'sha1', 7)).toThrow('Invalid TOTP parameters');
  });

  it('encodes provisioning labels and fixes the issuer and algorithm', () => {
    const uri = new URL(otpauthUri(secret, 'owner/a?b & c'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.hostname).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Lightning Pilot:owner/a?b & c');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret,
      issuer: 'Lightning Pilot',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
