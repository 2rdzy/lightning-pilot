import { describe, expect, it } from 'vitest';
import { createTranslator, fill, mergeMessages } from './messages.ts';

describe('messages', () => {
  it('fills placeholders and keeps unknown ones visible', () => {
    expect(fill('Pay {amount} sat', { amount: '25,000' })).toBe('Pay 25,000 sat');
    expect(fill('Pay {amount} sat')).toBe('Pay {amount} sat');
    expect(fill('{a}{b}', { a: 1, b: 'x' })).toBe('1x');
  });

  it('refuses a key defined in two files', () => {
    expect(mergeMessages({ a: 'A' }, { b: 'B' })).toEqual({ a: 'A', b: 'B' });
    expect(() => mergeMessages({ a: 'A' }, { a: 'again' })).toThrow('message key defined twice: a');
  });

  it('translates, falls back to the key, and picks plural forms with Intl.PluralRules', () => {
    const tr = createTranslator(
      { hello: 'Hello {name}', 'peers.one': '{count} peer', 'peers.other': '{count} peers', 'only.other': '{count}' },
      'en-US',
    );
    expect(tr.locale).toBe('en-US');
    expect(tr.t('hello', { name: 'Ann' })).toBe('Hello Ann');
    expect(tr.t('missing')).toBe('missing');
    expect(tr.has('hello')).toBe(true);
    expect(tr.has('missing')).toBe(false);
    expect(tr.plural('peers', 1)).toBe('1 peer');
    expect(tr.plural('peers', 3)).toBe('3 peers');
    expect(tr.plural('only', 1)).toBe('1');
    expect(tr.plural('none', 2)).toBe('none');
  });
});
