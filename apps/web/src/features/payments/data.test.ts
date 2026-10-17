import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../../api/client.ts';
import {
  filterHistory,
  historyQuery,
  PaymentsSearch,
  READ_LIMIT,
  receivedRows,
  sentRows,
  statusOf,
  STEP_PAGES,
  VIEW_SIZE,
  viewPage,
} from './data.ts';

const hash = (n: number) => n.toString(16).padStart(64, '0');

describe('history search parameters', () => {
  it('fall back to defaults for anything invalid, and keep a status only on its own tab', () => {
    expect(PaymentsSearch.parse({})).toEqual({ tab: 'sent', status: 'all', q: '', sort: '-time', more: 0, page: 1 });
    expect(PaymentsSearch.parse({ tab: 'x', status: 'nope', sort: 1, more: 99, page: -2, q: 'a'.repeat(300) })).toEqual(
      { tab: 'sent', status: 'all', q: '', sort: '-time', more: 0, page: 1 },
    );
    expect(PaymentsSearch.parse({ tab: 'received', status: 'paid', more: '2', page: '3' })).toMatchObject({
      more: 2,
      page: 3,
    });
    expect(statusOf('received', 'paid')).toBe('paid');
    expect(statusOf('sent', 'paid')).toBe('all');
    expect(statusOf('sent', 'failed')).toBe('failed');
  });
});

describe('history rows', () => {
  it('take the amount actually moved when the node knows it, and leave unknown fields out', () => {
    expect(
      sentRows([
        { paymentHash: hash(1), status: 'succeeded', amount: '1000', amountSent: '1001', fee: '1', destination: 'd' },
        { paymentHash: hash(2), status: 'pending' },
      ]),
    ).toEqual([
      { hash: hash(1), index: 0, status: 'succeeded', amount: '1001', fee: '1', counterparty: 'd' },
      { hash: hash(2), index: 1, status: 'pending' },
    ]);
    expect(
      receivedRows([
        { paymentHash: hash(3), status: 'paid', amount: '500', amountReceived: '600', description: '', label: 'lp-1' },
        {
          paymentHash: hash(4),
          status: 'unpaid',
          description: 'Coffee',
          label: 'x',
          createdAt: '2026-10-17T00:00:00Z',
        },
      ]),
    ).toEqual([
      { hash: hash(3), index: 0, status: 'paid', amount: '600', text: 'lp-1' },
      { hash: hash(4), index: 1, status: 'unpaid', text: 'Coffee', time: '2026-10-17T00:00:00Z' },
    ]);
  });

  it('are shown newest first by default, filtered by status and text, and sorted by exact amount', () => {
    const rows = sentRows([
      { paymentHash: hash(1), status: 'succeeded', amount: '9007199254740993000' },
      { paymentHash: hash(2), status: 'failed', amount: '5', label: 'Rent' },
      { paymentHash: hash(3), status: 'succeeded', amount: '9007199254740992000' },
    ]);
    expect(filterHistory(rows, 'all', '', '-time').map((r) => r.index)).toEqual([2, 1, 0]);
    expect(filterHistory(rows, 'all', '', 'time').map((r) => r.index)).toEqual([0, 1, 2]);
    // Beyond 2^53: compared as bigint, not as numbers.
    expect(filterHistory(rows, 'all', '', '-amount').map((r) => r.index)).toEqual([0, 2, 1]);
    expect(filterHistory(rows, 'all', '', 'amount').map((r) => r.index)).toEqual([1, 2, 0]);
    expect(filterHistory(rows, 'succeeded', '', '-time').map((r) => r.index)).toEqual([2, 0]);
    expect(filterHistory(rows, 'all', ' rent ', '-time').map((r) => r.index)).toEqual([1]);
    expect(filterHistory(rows, 'all', hash(3).slice(-6), '-time').map((r) => r.index)).toEqual([2]);
  });

  it('are split into screen pages, a page past the end showing the last one', () => {
    const rows = Array.from({ length: VIEW_SIZE * 2 + 1 }, (_, i) => i);
    expect(viewPage(rows, 1)).toMatchObject({ page: 1, pages: 3 });
    expect(viewPage(rows, 3).rows).toEqual([VIEW_SIZE * 2]);
    expect(viewPage(rows, 9)).toMatchObject({ page: 3, pages: 3 });
    expect(viewPage([], 1)).toEqual({ rows: [], page: 1, pages: 1 });
  });
});

describe('historyQuery', () => {
  function api(pages: number) {
    const call = vi.fn((_name: string, options: { query: { cursor?: string; limit: number } }) => {
      const n = options.query.cursor === undefined ? 0 : Number(options.query.cursor.slice(1));
      return Promise.resolve({
        items: [{ paymentHash: hash(n), status: 'succeeded', description: '', label: '' }],
        ...(n + 1 < pages ? { nextCursor: `i${n + 1}` } : {}),
      });
    });
    return { client: { call } as unknown as ApiClient, call };
  }
  const run = (client: ApiClient, tab: 'sent' | 'received', more: number) => {
    const options = historyQuery(client, 'n1', tab, more);
    return (options.queryFn as unknown as () => Promise<{ rows: { hash: string }[]; more: boolean }>)();
  };

  it('reads at most STEP_PAGES pages per step, at the API maximum, and says when the node has more', async () => {
    const { client, call } = api(STEP_PAGES + 3);
    const first = await run(client, 'sent', 0);
    expect(first.rows).toHaveLength(STEP_PAGES);
    expect(first.more).toBe(true);
    expect(call).toHaveBeenCalledTimes(STEP_PAGES);
    expect(call.mock.calls[0]?.[0]).toBe('payments');
    expect(call.mock.calls[0]?.[1]).toMatchObject({ params: { nodeId: 'n1' }, query: { limit: READ_LIMIT } });
    const all = await run(client, 'received', 1);
    expect(all.rows).toHaveLength(STEP_PAGES + 3);
    expect(all.more).toBe(false);
    expect(call.mock.calls.at(-1)?.[0]).toBe('invoices');
  });

  it('stops on a repeated cursor instead of looping', async () => {
    const call = vi.fn(() => Promise.resolve({ items: [], nextCursor: 'i1' }));
    await expect(run({ call } as unknown as ApiClient, 'sent', 0)).rejects.toBeInstanceOf(ApiError);
  });
});
