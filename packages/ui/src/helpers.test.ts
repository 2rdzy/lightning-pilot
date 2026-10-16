import { describe, expect, it } from 'vitest';
import { cx } from './cx.ts';
import { cutText, localShare, nextSort, shortenId, sortFromParam, sortToParam } from './helpers.ts';
import { qrPath } from './qr.ts';

describe('ids and untrusted text', () => {
  it('shortens ids to the first and last 8 characters', () => {
    const pubkey = `02${'ab'.repeat(32)}`;
    expect(shortenId(pubkey)).toBe(`${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`);
    expect(shortenId('short-id')).toBe('short-id');
    expect(shortenId('x'.repeat(20))).toBe('x'.repeat(20));
  });

  it('cuts aliases to 32 characters without splitting a character', () => {
    expect(cutText('alice')).toBe('alice');
    expect(cutText('a'.repeat(32))).toBe('a'.repeat(32));
    expect(cutText('a'.repeat(40))).toBe(`${'a'.repeat(31)}…`);
    // A family emoji: three people joined by zero-width joiners, one user-perceived character.
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(cutText(family.repeat(40), 4)).toBe(`${family.repeat(3)}…`);
  });
});

describe('liquidity', () => {
  it('gives the local share in per mille from msat amounts', () => {
    expect(localShare(600_000_000n, 400_000_000n)).toBe(600);
    expect(localShare(0n, 5n)).toBe(0);
    expect(localShare(5n, 0n)).toBe(1000);
    // Far beyond Number's exact range: integer arithmetic stays exact.
    expect(localShare(2n ** 80n, 2n ** 80n)).toBe(500);
  });

  it('has no share for an empty channel and refuses negative balances', () => {
    expect(localShare(0n, 0n)).toBeUndefined();
    expect(() => localShare(-1n, 1n)).toThrow(RangeError);
  });
});

describe('table sort', () => {
  it('sorts a new column ascending and flips the same column', () => {
    const asc = nextSort(undefined, 'local');
    expect(asc).toEqual({ column: 'local', direction: 'asc' });
    expect(nextSort(asc, 'local')).toEqual({ column: 'local', direction: 'desc' });
    expect(nextSort({ column: 'local', direction: 'desc' }, 'local')).toEqual({ column: 'local', direction: 'asc' });
    expect(nextSort({ column: 'local', direction: 'desc' }, 'state')).toEqual({ column: 'state', direction: 'asc' });
  });

  it('keeps the sort in a search param and refuses unknown columns', () => {
    expect(sortToParam({ column: 'local', direction: 'asc' })).toBe('local');
    expect(sortToParam({ column: 'local', direction: 'desc' })).toBe('-local');
    expect(sortFromParam('-local', ['local'])).toEqual({ column: 'local', direction: 'desc' });
    expect(sortFromParam('local', ['local'])).toEqual({ column: 'local', direction: 'asc' });
    expect(sortFromParam('-other', ['local'])).toBeUndefined();
    expect(sortFromParam(3, ['local'])).toBeUndefined();
  });
});

describe('small helpers', () => {
  it('joins class names and skips empty ones', () => {
    expect(cx('a', false, undefined, null, '', 'b')).toBe('a b');
  });

  it('draws invoices in upper case and keeps other text as it is', () => {
    const upper = qrPath('lnbcrt1abc');
    expect(upper.path).toBe(qrPath('LNBCRT1ABC').path);
    // A quiet zone of four modules on each side.
    expect(upper.size % 2).toBe(1);
    expect(upper.path.startsWith('M4 4')).toBe(true);
    expect(qrPath('otpauth://totp/x?secret=ab', true).path).not.toBe(qrPath('otpauth://totp/x?secret=ab').path);
  });
});
