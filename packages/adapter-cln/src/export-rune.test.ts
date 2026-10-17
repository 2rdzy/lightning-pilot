import { describe, expect, it } from 'vitest';
import { isExportableViewRune } from './export-rune.ts';
import { runeRestrictions } from './rune.ts';

const clauses = JSON.parse(runeRestrictions('read')) as string[][];
const restrictions = clauses.map((clause) => clause.join('|')).join('&');
const wire = (text: string, hash = Buffer.alloc(32, 255)) =>
  Buffer.concat([hash, Buffer.from(text)])
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
const valid = wire(`=7&${restrictions}`);

describe('isExportableViewRune', () => {
  it('accepts generated read restrictions with an opaque MAC and numeric identifier', () => {
    expect(isExportableViewRune(valid)).toBe(true);
    expect(isExportableViewRune(wire(`=123456789&${restrictions}`, Buffer.alloc(32)))).toBe(true);
  });

  it('accepts the view scope made before listaddresses joined it, and no other subset', () => {
    const without = (method: string) =>
      clauses.map((clause) => clause.filter((alternative) => alternative !== `method=${method}`).join('|')).join('&');
    expect(restrictions).toContain('method=listaddresses');
    expect(isExportableViewRune(wire(`=8&${without('listaddresses')}`))).toBe(true);
    expect(isExportableViewRune(wire(`=9&${without('listfunds')}`))).toBe(false);
  });

  it('accepts reordered alternatives as emitted by real CLN fixtures', () => {
    const reordered = clauses.map((clause) => [...clause].reverse().join('|')).join('&');
    expect(isExportableViewRune(wire(`=8&${reordered}`))).toBe(true);
  });

  it.each([
    ['unrestricted', '=7'],
    ['admin', '=7&id!&method=createrune'],
    [
      'spend',
      `=7&${(JSON.parse(runeRestrictions('spend')) as string[][]).map((clause) => clause.join('|')).join('&')}`,
    ],
    ['wildcard', `=7&${restrictions.replace('method=getinfo', 'method^get')}`],
    ['extra method', `=7&${restrictions.replace('method=getinfo', 'method=getinfo|method=stop')}`],
    ['duplicate method', `=7&${restrictions.replace('method=getinfo', 'method=getinfo|method=getinfo')}`],
    ['extra clause', `=7&${restrictions}&method=getinfo`],
    [
      'missing clause',
      `=7&${clauses
        .slice(1)
        .map((clause) => clause.join('|'))
        .join('&')}`,
    ],
    [
      'reordered clauses',
      `=7&${[...clauses]
        .reverse()
        .map((clause) => clause.join('|'))
        .join('&')}`,
    ],
    ['missing id', restrictions],
    ['invalid id', `=x&${restrictions}`],
    ['negative id', `=-7&${restrictions}`],
    ['escaped delimiter', `=7&${restrictions.replace('method=getinfo', 'method=getinfo\\|method=stop')}`],
    ['escaped literal', `=7&${restrictions}\\`],
    ['NUL', `=7&${restrictions}\0`],
    ['non-ASCII', `=7&${restrictions}é`],
    ['empty alternative', `=7&${restrictions}|`],
    ['empty clause', `=7&${restrictions}&`],
  ])('rejects %s restrictions', (_name, text) => {
    expect(isExportableViewRune(wire(text))).toBe(false);
  });

  it('rejects malformed, noncanonical and oversized wire encodings', () => {
    const padded = [0, 1, 2].map((n) => wire(`=${'1'.repeat(n + 1)}&${restrictions}`));
    for (const value of padded) expect(isExportableViewRune(value)).toBe(true);
    const withPadding = padded.find((value) => value.endsWith('='));
    expect(withPadding).toBeDefined();
    if (!withPadding) throw new Error('Missing padded test case');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const unpadded = withPadding.replaceAll('=', '');
    const last = unpadded.at(-1);
    if (!last) throw new Error('Missing encoded test content');
    const noncanonical =
      unpadded.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1] + withPadding.slice(unpadded.length);
    expect(Buffer.from(noncanonical, 'base64url')).toEqual(Buffer.from(withPadding, 'base64url'));
    for (const value of [
      '',
      '!!!!',
      'A',
      valid + '=',
      valid + '\n',
      valid.replaceAll('_', '/'),
      withPadding.replaceAll('=', ''),
      noncanonical,
      wire(`=7&${restrictions}`, Buffer.alloc(31)),
      Buffer.alloc(32).toString('base64'),
      'A'.repeat(4100),
    ])
      expect(isExportableViewRune(value)).toBe(false);
  });
});
