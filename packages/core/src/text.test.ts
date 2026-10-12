import { describe, expect, it } from 'vitest';
import { untrustedText } from './text.ts';

describe('untrustedText', () => {
  it('strips control and bidirectional formatting characters, keeping tab and newline', () => {
    const input = ['a', '\u0000', '\u0007', '\t', '\n', '\u001b[31m', '‮', 'b', '⁦', '‏', 'c'].join('');
    expect(untrustedText(input)).toBe('a\t\n[31mbc');
  });

  it('cuts to the maximum length by code point', () => {
    expect(untrustedText('x'.repeat(1000)).length).toBe(640);
    expect(Array.from(untrustedText('\u{1F600}'.repeat(10), 3))).toHaveLength(3);
  });
});
