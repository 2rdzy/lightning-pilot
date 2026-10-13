// What every part of the adapter shares: the call function (which picks the rune from the method table), reply
// parsing, paging and small conversions.
import { AdapterError, msat, PAGE_LIMIT_MAX, type Msat, type PageRequest } from '@lightning-pilot/core';
import type { z } from 'zod';
import type { ClnRestClient } from './client.ts';
import { METHODS, type ClnMethod } from './methods.ts';

export type Transport = Pick<ClnRestClient, 'call'>;

export interface CallOverrides {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type Call = (command: ClnMethod, params: Record<string, unknown>, overrides?: CallOverrides) => Promise<unknown>;

export const credentialOf = (command: ClnMethod) =>
  METHODS.find((row) => (row.nodeMethods as readonly string[]).includes(command))?.credential;

export interface CallContext {
  transport: Transport;
  viewRune: string;
  spendRune: string | undefined;
  readTimeoutMs: number;
  onCall: ((command: string, credential: 'read' | 'spend') => void) | undefined;
}

// The rune is chosen from the method table, never by the caller: a read command can only go out with the view
// rune and a spend command only with the spend rune.
export function makeCall(context: CallContext): Call {
  return async (command, params, overrides = {}) => {
    const credential = credentialOf(command);
    if (credential !== 'read' && credential !== 'spend') throw new Error(`${command} is not in the method table`);
    const rune = credential === 'spend' ? context.spendRune : context.viewRune;
    if (!rune) throw new AdapterError({ code: 'permission_denied', sent: false, definitive: true });
    context.onCall?.(command, credential);
    return context.transport.call(command, params, {
      rune,
      timeoutMs: overrides.timeoutMs ?? context.readTimeoutMs,
      ...(overrides.signal ? { signal: overrides.signal } : {}),
    });
  };
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AdapterError({ code: 'node_bad_response', sent: true, definitive: false, detail: result.error.message });
  }
  return result.data;
}

// Thrown for a caller mistake detected before anything is sent (a bad cursor, an amount that is not whole sats).
export const invalidRequest = (detail: string) =>
  new AdapterError({ code: 'validation_failed', sent: false, definitive: true, detail });

export const DEFAULT_PAGE = 50;

export function pageLimit(page: PageRequest | undefined): number {
  const limit = page?.limit ?? DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) throw invalidRequest('page limit');
  return limit;
}

// Cursors: `i<n>` = the next node index to start from (CLN `created_index`), `o<n>` = an offset into a list the
// node cannot page. Opaque to callers; refused if malformed.
export function cursorStart(page: PageRequest | undefined, kind: 'i' | 'o'): number {
  const cursor = page?.cursor;
  if (cursor === undefined) return 0;
  const match = /^([io])([0-9]{1,15})$/.exec(cursor);
  if (!match || match[1] !== kind) throw invalidRequest('cursor');
  return Number(match[2]);
}

// One page of a list the node pages by `created_index`: ask for one row more than the limit, to know whether there
// is a next page without an empty last request.
export function indexPage<R extends { created_index: number }, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
): { items: T[]; nextCursor?: string } {
  const sorted = [...rows].sort((a, b) => a.created_index - b.created_index);
  const items = sorted.slice(0, limit).map(map);
  const next = sorted[limit];
  return next === undefined ? { items } : { items, nextCursor: `i${next.created_index}` };
}

// One page of a list the node returns whole.
// Called before the node is asked, so a malformed page is refused as not sent.
export function checkOffsetPage(page: PageRequest | undefined): void {
  pageLimit(page);
  cursorStart(page, 'o');
}

export function offsetPage<T>(all: T[], page: PageRequest | undefined): { items: T[]; nextCursor?: string } {
  const limit = pageLimit(page);
  const start = cursorStart(page, 'o');
  const items = all.slice(start, start + limit);
  return start + limit < all.length ? { items, nextCursor: `o${start + limit}` } : { items };
}

export const isoFromSeconds = (seconds: number) => new Date(Math.round(seconds * 1000)).toISOString();

// Fee rates: CLN's perkb (sat per 1000 vbytes) → sat/vB as an exact decimal string.
export function perkbToSatPerVbyte(perkb: number): string {
  const whole = Math.floor(perkb / 1000);
  const fraction = (perkb % 1000).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction === '' ? `${whole}` : `${whole}.${fraction}`;
}

// sat/vB as a decimal string → CLN's `<n>perkb` (sat/vB × 1000, whole numbers only).
export function satPerVbyteToPerkb(rate: string): string {
  const match = /^([0-9]{1,7})(?:\.([0-9]{1,3}))?$/.exec(rate);
  if (!match) throw invalidRequest('fee rate');
  const perkb = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  return `${perkb}perkb`;
}

// The node funds and sends in whole satoshis; an amount with millisatoshis left over is a caller mistake.
export function wholeSats(amount: Msat): bigint {
  if (amount % 1000n !== 0n) throw invalidRequest('amount is not whole satoshis');
  return amount / 1000n;
}

export const sumMsat = (values: bigint[]): Msat => msat(values.reduce((a, b) => a + b, 0n));
