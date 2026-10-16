// Pure helpers behind the value components, kept apart so they are unit-tested in Node and counted by coverage.

// Ids and keys: the first 8 and last 8 characters (style guide §6); short values stay whole.
export function shortenId(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

// Untrusted text (node aliases): cut to a number of characters, counting user-perceived characters rather than
// UTF-16 units so an emoji or a combined letter is never split.
export function cutText(value: string, max = 32): string {
  const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map((s) => s.segment);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

// The local share of a channel in per mille, from msat amounts, without floating point on the amounts themselves.
// An empty channel has no share (undefined) rather than a bar that pretends to be half full.
export function localShare(local: bigint, remote: bigint): number | undefined {
  if (local < 0n || remote < 0n) throw new RangeError('negative channel balance');
  const total = local + remote;
  if (total === 0n) return undefined;
  return Number((local * 1000n) / total);
}

export type SortDirection = 'asc' | 'desc';
export interface Sort {
  column: string;
  direction: SortDirection;
}

// Clicking a column header: a new column sorts ascending; the same column flips direction.
export function nextSort(current: Sort | undefined, column: string): Sort {
  if (current?.column !== column) return { column, direction: 'asc' };
  return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

// Search-param form of a sort (style guide §7: sort lives in the URL), e.g. "local" or "-local".
export function sortToParam(sort: Sort): string {
  return sort.direction === 'desc' ? `-${sort.column}` : sort.column;
}

export function sortFromParam(param: unknown, columns: readonly string[]): Sort | undefined {
  if (typeof param !== 'string') return undefined;
  const direction: SortDirection = param.startsWith('-') ? 'desc' : 'asc';
  const column = direction === 'desc' ? param.slice(1) : param;
  return columns.includes(column) ? { column, direction } : undefined;
}
