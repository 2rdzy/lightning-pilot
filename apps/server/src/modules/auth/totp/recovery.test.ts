import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode } from './recovery.ts';

describe('recovery codes', () => {
  it('generates ten distinct 80-bit Base32 codes in readable groups', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/);
    expect(generateRecoveryCodes()).not.toEqual(codes);
  });

  it('hashes the normalized code without storing plaintext', () => {
    const code = 'ABCD-EFGH-IJKL-MNOP';
    const hash = hashRecoveryCode(code);
    expect(hash).toBe(createHash('sha256').update('ABCDEFGHIJKLMNOP').digest('hex'));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('ABCD');
    expect(verifyRecoveryCode(code, hash)).toBe(true);
    expect(verifyRecoveryCode('abcd efgh ijkl mnop', hash)).toBe(true);
    expect(verifyRecoveryCode('abcdefghijklmnop', hash)).toBe(true);
    expect(verifyRecoveryCode('ABCD-EFGH-IJKL-MNOQ', hash)).toBe(false);
  });

  it.each([
    '',
    'ABCD-EFGH-IJKL-MNO',
    'ABCD-EFGH-IJKL-MNOPQ',
    'ABCD_EFGH_IJKL_MNOP',
    'ABCD/EFGH/IJKL/MNOP',
    'ABCD\tEFGH IJKL MNOP',
    'ABCD-EFGH-IJKL-MNO0',
    'ABCD-EFGH-IJKL-MNO8',
    'ＡBCD-EFGH-IJKL-MNOP',
  ])('rejects malformed code %j with a fixed error', (code) => {
    expect(() => hashRecoveryCode(code)).toThrow('Invalid recovery code');
    expect(verifyRecoveryCode(code, hashRecoveryCode('ABCD-EFGH-IJKL-MNOP'))).toBe(false);
  });

  it.each(['', '0'.repeat(63), '0'.repeat(65), 'g'.repeat(64), 'A'.repeat(64)])(
    'rejects malformed stored hash %j',
    (hash) => {
      expect(verifyRecoveryCode('ABCD-EFGH-IJKL-MNOP', hash)).toBe(false);
    },
  );
});
