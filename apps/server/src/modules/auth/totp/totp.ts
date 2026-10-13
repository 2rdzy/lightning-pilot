import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
type Algorithm = 'sha1' | 'sha256' | 'sha512';
type Digits = 6 | 8;

function decodeSecret(secret: string): Buffer {
  if (!/^[A-Z2-7]+$/.test(secret) || ![0, 2, 4, 5, 7].includes(secret.length % 8)) {
    throw new Error('Invalid TOTP secret');
  }
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const character of secret) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  if (value !== 0) throw new Error('Invalid TOTP secret');
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let result = '';
  let value = 0;
  let bits = 0;
  try {
    for (const byte of bytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        result += BASE32[(value >>> bits) & 31];
      }
      value &= (1 << bits) - 1;
    }
    return result;
  } finally {
    bytes.fill(0);
  }
}

export function hotp(secret: string, counter: bigint, algorithm: Algorithm = 'sha1', digits: Digits = 6): string {
  if (counter < 0n || counter > 0xffffffffffffffffn) throw new Error('Invalid TOTP counter');
  if (!['sha1', 'sha256', 'sha512'].includes(algorithm) || (digits !== 6 && digits !== 8)) {
    throw new Error('Invalid TOTP parameters');
  }
  const key = decodeSecret(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  try {
    const digest = createHmac(algorithm, key).update(message).digest();
    const offset = digest.readUInt8(digest.length - 1) & 15;
    const binary = digest.readUInt32BE(offset) & 0x7fffffff;
    digest.fill(0);
    return (binary % 10 ** digits).toString().padStart(digits, '0');
  } finally {
    key.fill(0);
    message.fill(0);
  }
}

function timeCounter(now: Date): bigint {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Invalid TOTP time');
  return BigInt(Math.floor(milliseconds / 30_000));
}

export function totp(secret: string, now: Date, algorithm: Algorithm = 'sha1', digits: Digits = 6): string {
  return hotp(secret, timeCounter(now), algorithm, digits);
}

// The caller must atomically persist the returned counter with accepting the authentication attempt.
export function matchTotp(secret: string, code: string, now: Date, lastCounter: bigint = -1n): bigint | undefined {
  if (!/^[0-9]{6}$/.test(code)) return undefined;
  const current = timeCounter(now);
  const supplied = Buffer.from(code);
  let matched: bigint | undefined;
  for (const offset of [-1n, 0n, 1n]) {
    const counter = current + offset;
    if (counter < 0n) continue;
    const expected = Buffer.from(hotp(secret, counter));
    if (timingSafeEqual(supplied, expected) && counter > lastCounter) matched = counter;
  }
  return matched;
}

export function otpauthUri(secret: string, label: string): string {
  const key = decodeSecret(secret);
  key.fill(0);
  const issuer = 'Lightning Pilot';
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?${query.toString()}`;
}
