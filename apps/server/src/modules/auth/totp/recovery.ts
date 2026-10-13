import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Ten distinct one-time codes, each containing 80 bits from the OS CSPRNG. */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < 10) {
    const bytes = randomBytes(10);
    let accumulator = 0;
    let bits = 0;
    let encoded = '';
    for (const byte of bytes) {
      accumulator = (accumulator << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        encoded += BASE32[(accumulator >>> bits) & 31];
      }
    }
    codes.add(Array.from({ length: 4 }, (_, i) => encoded.slice(i * 4, i * 4 + 4)).join('-'));
  }
  return [...codes];
}

function normalizeRecoveryCode(code: string): string {
  if (!/^[A-Za-z2-7 -]+$/.test(code)) throw new Error('Invalid recovery code');
  const normalized = code.replace(/[ -]/g, '').toUpperCase();
  if (normalized.length !== 16) throw new Error('Invalid recovery code');
  return normalized;
}

/** Store only this digest; the human-readable code must never be persisted. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code), 'ascii').digest('hex');
}

export function verifyRecoveryCode(code: string, hash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  try {
    return timingSafeEqual(Buffer.from(hashRecoveryCode(code), 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}
