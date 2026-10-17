// Payment and invoice history (catalogue D11). The node pages its history oldest first and forward only, with no
// server-side order, filter or search (read API, WP14b). So the screen reads a bounded number of pages in node
// order, shows them newest first, filters and sorts only the loaded rows, and says when more exist.
import { PaymentHashSchema } from '@lightning-pilot/core';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, type ApiClient } from '../../api/client.ts';

// Rows per request (the read API's maximum), requests per "load more" step, rows per screen page.
export const READ_LIMIT = 200;
export const STEP_PAGES = 10;
export const MAX_STEPS = 5;
export const VIEW_SIZE = 50;

export const SENT_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export const RECEIVED_STATUSES = ['unpaid', 'paid', 'expired'] as const;
export type HistoryTab = 'sent' | 'received';

export const PaymentsSearch = z.object({
  tab: z.enum(['sent', 'received']).catch('sent'),
  status: z.enum(['all', ...SENT_STATUSES, ...RECEIVED_STATUSES]).catch('all'),
  q: z.string().max(200).catch(''),
  sort: z.enum(['-time', 'time', '-amount', 'amount']).catch('-time'),
  // Load-more steps beyond the first (each reads STEP_PAGES more node pages).
  more: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_STEPS - 1)
    .catch(0),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});
export type PaymentsSearch = z.infer<typeof PaymentsSearch>;
export const PAYMENTS_DEFAULTS: PaymentsSearch = { tab: 'sent', status: 'all', q: '', sort: '-time', more: 0, page: 1 };
export { PaymentHashSchema };

// A status from the other tab (a hand-edited or stale link) means "all", never an empty list or an error.
export function statusOf(tab: HistoryTab, status: string): string {
  const own: readonly string[] = tab === 'sent' ? SENT_STATUSES : RECEIVED_STATUSES;
  return own.includes(status) ? status : 'all';
}

// Up to `pages` node pages, in node order; `more` tells whether the node has rows beyond them.
async function readPages<T>(
  read: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string | undefined }>,
  pages: number,
): Promise<{ items: T[]; more: boolean }> {
  const first = await read();
  const items = [...first.items];
  let nextCursor = first.nextCursor;
  const seen = new Set<string>();
  for (let i = 1; i < pages && nextCursor !== undefined; i++) {
    if (seen.has(nextCursor)) throw new ApiError('bad_response', 'Repeated history cursor', 0);
    seen.add(nextCursor);
    const next = await read(nextCursor);
    items.push(...next.items);
    nextCursor = next.nextCursor;
  }
  return { items, more: nextCursor !== undefined };
}

// One row of either tab. `index` is the node's order (oldest first), the only order every row has.
export interface HistoryRow {
  hash: string;
  index: number;
  status: string;
  amount?: string;
  fee?: string;
  time?: string;
  counterparty?: string;
  text?: string;
}

// Optional fields are left out rather than set to undefined (exactOptionalPropertyTypes).
function row(fields: Record<string, string | number | undefined>): HistoryRow {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== ''),
  ) as unknown as HistoryRow;
}

export function sentRows(items: readonly SentRecord[]): HistoryRow[] {
  return items.map((p, index) =>
    row({
      hash: p.paymentHash,
      index,
      status: p.status,
      amount: p.amountSent ?? p.amount,
      fee: p.fee,
      time: p.completedAt ?? p.createdAt,
      counterparty: p.destination,
      text: p.label,
    }),
  );
}

export function receivedRows(items: readonly ReceivedRecord[]): HistoryRow[] {
  return items.map((i, index) =>
    row({
      hash: i.paymentHash,
      index,
      status: i.status,
      amount: i.amountReceived ?? i.amount,
      time: i.paidAt ?? i.createdAt,
      text: i.description || i.label,
    }),
  );
}

export interface SentRecord {
  paymentHash: string;
  status: string;
  destination?: string | undefined;
  amount?: string | undefined;
  amountSent?: string | undefined;
  fee?: string | undefined;
  createdAt?: string | undefined;
  completedAt?: string | undefined;
  label?: string | undefined;
}
export interface ReceivedRecord {
  paymentHash: string;
  status: string;
  amount?: string | undefined;
  amountReceived?: string | undefined;
  description: string;
  label: string;
  createdAt?: string | undefined;
  paidAt?: string | undefined;
}
export const historyQuery = (api: ApiClient, nodeId: string, tab: HistoryTab, more: number) =>
  queryOptions({
    queryKey: [tab === 'sent' ? 'payments' : 'invoices', nodeId, more],
    queryFn: async (): Promise<{ rows: HistoryRow[]; more: boolean }> => {
      const pages = (more + 1) * STEP_PAGES;
      if (tab === 'sent') {
        const read = await readPages(
          (cursor) => api.call('payments', { params: { nodeId }, query: { limit: READ_LIMIT, cursor } }),
          pages,
        );
        return { rows: sentRows(read.items), more: read.more };
      }
      const read = await readPages(
        (cursor) => api.call('invoices', { params: { nodeId }, query: { limit: READ_LIMIT, cursor } }),
        pages,
      );
      return { rows: receivedRows(read.items), more: read.more };
    },
  });

export function filterHistory(rows: readonly HistoryRow[], status: string, q: string, sort: string): HistoryRow[] {
  const text = q.trim().toLowerCase();
  const direction = sort.startsWith('-') ? -1 : 1;
  const amount = (row: HistoryRow) => BigInt(row.amount ?? '0');
  return rows
    .filter(
      (row) =>
        (status === 'all' || row.status === status) &&
        (text === '' || [row.hash, row.counterparty, row.text].some((s) => s?.toLowerCase().includes(text))),
    )
    .sort((a, b) => {
      if (sort.endsWith('amount')) {
        const x = amount(a),
          y = amount(b);
        if (x !== y) return direction * (x < y ? -1 : 1);
      }
      return (sort.endsWith('amount') ? -1 : direction) * (a.index - b.index);
    });
}

// The rows of one screen page, and how many pages there are.
export function viewPage<T>(rows: readonly T[], page: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / VIEW_SIZE));
  const current = Math.min(page, pages);
  return { rows: rows.slice((current - 1) * VIEW_SIZE, current * VIEW_SIZE), page: current, pages };
}
