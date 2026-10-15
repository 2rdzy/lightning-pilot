import { runeRestrictions } from './rune.ts';

const VIEW_CLAUSES = (JSON.parse(runeRestrictions('read')) as string[][]).map((clause) => [...clause].sort());

// This recognizes only our generated view scope, not arbitrary CLN rune expressions. The MAC is opaque: node
// authentication and the pinned TLS/chain identity checks are still required before using an imported credential.
export function isExportableViewRune(rune: string): boolean {
  if (
    rune.length === 0 ||
    rune.length > 4096 ||
    !/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}==|[A-Za-z0-9_-]{3}=)?$/.test(rune)
  )
    return false;
  const decoded = Buffer.from(rune, 'base64url');
  if (decoded.length <= 32 || decoded.toString('base64').replaceAll('+', '-').replaceAll('/', '_') !== rune)
    return false;
  const restrictions = decoded.subarray(32);
  if (restrictions.some((byte) => byte === 0 || byte === 92 || byte > 127)) return false;
  const text = restrictions.toString('ascii');
  const prefix = /^=[0-9]+&/.exec(text);
  if (!prefix) return false;
  const clauses = text.slice(prefix[0].length).split('&');
  if (clauses.length !== VIEW_CLAUSES.length) return false;
  return clauses.every((clause, index) => {
    const alternatives = clause.split('|').sort();
    const expected = VIEW_CLAUSES[index];
    return (
      expected !== undefined &&
      new Set(alternatives).size === alternatives.length &&
      alternatives.length === expected.length &&
      alternatives.every((alternative, position) => alternative === expected[position])
    );
  });
}
