// Node events from CLN's `wait` subsystems (domain and adapter §6). For each watched index, `wait` blocks until the
// index passes the last value seen; the changed rows are then read with the list command from that value, so a
// restart resumes exactly where the stored cursor says, without missing or repeating a row. Blocks come from
// `waitblockheight`. The cursor carries the last index handled per watch and the last block height.
import {
  AdapterError,
  msat,
  parsePaymentHash,
  sub,
  type EventCursor,
  type NodeEvent,
  type PaymentStatus,
} from '@lightning-pilot/core';
import { parse, type Call } from './context.ts';
import { forward } from './mappers.ts';
import {
  GetInfo,
  ListForwards,
  ListInvoices,
  ListSendPays,
  WaitBlockHeight,
  WaitReply,
  type ForwardRow,
  type InvoiceRow,
  type SendPayRow,
} from './schemas.ts';

const WATCHES = [
  { key: 'invoices.updated', subsystem: 'invoices', index: 'updated' },
  { key: 'sendpays.created', subsystem: 'sendpays', index: 'created' },
  { key: 'sendpays.updated', subsystem: 'sendpays', index: 'updated' },
  { key: 'forwards.created', subsystem: 'forwards', index: 'created' },
  { key: 'forwards.updated', subsystem: 'forwards', index: 'updated' },
] as const;
type WatchKey = (typeof WATCHES)[number]['key'] | 'block';
const KEYS: readonly WatchKey[] = [...WATCHES.map((w) => w.key), 'block'];
type CursorState = Record<WatchKey, number>;

const CURSOR_PREFIX = 'cln1.';
// How long one `wait` may block before it is asked again; a quiet node is not an error.
export const WAIT_TIMEOUT_MS = 5 * 60_000;
const BLOCK_WAIT_SECONDS = 60;
const LIST_BATCH = 100;
// CLN answers waitblockheight with this code when its own timeout passes.
const WAIT_TIMED_OUT = 2000;

export function encodeCursor(state: CursorState): EventCursor {
  return CURSOR_PREFIX + KEYS.map((k) => state[k]).join('.');
}

export function decodeCursor(cursor: EventCursor): CursorState {
  const parts = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length).split('.') : [];
  if (parts.length !== KEYS.length || parts.some((p) => !/^[0-9]{1,15}$/.test(p))) {
    throw new AdapterError({ code: 'validation_failed', sent: false, definitive: true, detail: 'event cursor' });
  }
  return Object.fromEntries(KEYS.map((k, i) => [k, Number(parts[i])])) as CursorState;
}

const PAY_STATUS: Record<string, PaymentStatus> = { pending: 'pending', complete: 'succeeded', failed: 'failed' };

function invoiceEvent(row: InvoiceRow): NodeEvent | undefined {
  const paymentHash = parsePaymentHash(row.payment_hash);
  if (row.status === 'paid') {
    return {
      type: 'invoice.paid',
      data: { paymentHash, amountReceived: msat(row.amount_received_msat ?? 0n), label: row.label },
    };
  }
  if (row.status === 'expired') return { type: 'invoice.expired', data: { paymentHash, label: row.label } };
  return undefined;
}

function paymentEvent(row: SendPayRow): NodeEvent | undefined {
  const status = PAY_STATUS[row.status];
  if (!status) return undefined;
  const sent = row.amount_sent_msat;
  const amount = row.amount_msat;
  return {
    type: 'payment.updated',
    data: {
      paymentHash: parsePaymentHash(row.payment_hash),
      status,
      ...(sent === undefined ? {} : { amountSent: msat(sent) }),
      ...(sent !== undefined && amount !== undefined && sent >= amount ? { fee: sub(msat(sent), msat(amount)) } : {}),
    },
  };
}

const forwardEvent = (row: ForwardRow): NodeEvent => ({ type: 'forward.updated', data: forward(row) });

const isTimeout = (err: unknown) =>
  err instanceof AdapterError &&
  ((err.code === 'node_unreachable' && err.detail === 'timeout') || err.nodeCode === WAIT_TIMED_OUT);

interface Item {
  event: NodeEvent;
  key: WatchKey;
  value: number;
}

export function subscribe(
  call: Call,
  cursor: EventCursor | undefined,
  outer: AbortSignal | undefined,
): AsyncIterable<{ event: NodeEvent; cursor: EventCursor }> {
  return {
    async *[Symbol.asyncIterator]() {
      const controller = new AbortController();
      const signal = controller.signal;
      const onOuterAbort = () => controller.abort();
      outer?.addEventListener('abort', onOuterAbort, { once: true });
      if (outer?.aborted) controller.abort();

      const queue: Item[] = [];
      let failure: unknown;
      let wake: (() => void) | undefined;
      const notify = () => {
        wake?.();
        wake = undefined;
      };
      const push = (item: Item) => {
        queue.push(item);
        notify();
      };

      try {
        const state = cursor === undefined ? await present(call, signal) : decodeCursor(cursor);
        const watchers = [
          ...WATCHES.map((w) => watch(call, w, state[w.key], signal, push)),
          watchBlocks(call, state.block, signal, push),
        ];
        for (const watcher of watchers) {
          watcher.catch((err: unknown) => {
            if (signal.aborted) return;
            failure ??= err;
            controller.abort();
            notify();
          });
        }
        signal.addEventListener('abort', notify, { once: true });
        while (true) {
          const item = queue.shift();
          if (item) {
            state[item.key] = item.value;
            yield { event: item.event, cursor: encodeCursor(state) };
            continue;
          }
          if (failure !== undefined) throw failure;
          if (signal.aborted) return;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        outer?.removeEventListener('abort', onOuterAbort);
        controller.abort();
      }
    },
  };
}

// The current value of every index and the current height: a stream without a cursor starts at the present.
async function present(call: Call, signal: AbortSignal): Promise<CursorState> {
  const state = { block: 0 } as CursorState;
  for (const w of WATCHES) {
    // `wait` returns at once when the index has already reached `nextvalue`.
    const reply = parse(
      WaitReply,
      await call('wait', { subsystem: w.subsystem, indexname: w.index, nextvalue: 0 }, { signal }),
    );
    state[w.key] = reply[w.index] ?? 0;
  }
  state.block = parse(GetInfo, await call('getinfo', {}, { signal })).blockheight;
  return state;
}

async function watch(
  call: Call,
  w: (typeof WATCHES)[number],
  from: number,
  signal: AbortSignal,
  push: (item: Item) => void,
): Promise<void> {
  let last = from;
  while (!signal.aborted) {
    let reached: number;
    try {
      const reply = parse(
        WaitReply,
        await call(
          'wait',
          { subsystem: w.subsystem, indexname: w.index, nextvalue: last + 1 },
          { timeoutMs: WAIT_TIMEOUT_MS, signal },
        ),
      );
      reached = reply[w.index] ?? last;
    } catch (err) {
      if (isTimeout(err) && !signal.aborted) continue;
      throw err;
    }
    const indexField = w.index === 'created' ? 'created_index' : 'updated_index';
    const params = { index: w.index, start: last + 1, limit: LIST_BATCH };
    const rows: { index: number; event: NodeEvent | undefined }[] = [];
    if (w.subsystem === 'invoices') {
      for (const row of parse(ListInvoices, await call('listinvoices', params, { signal })).invoices) {
        rows.push({ index: row[indexField] ?? 0, event: invoiceEvent(row) });
      }
    } else if (w.subsystem === 'sendpays') {
      for (const row of parse(ListSendPays, await call('listsendpays', params, { signal })).payments) {
        rows.push({ index: row[indexField] ?? 0, event: paymentEvent(row) });
      }
    } else {
      for (const row of parse(ListForwards, await call('listforwards', params, { signal })).forwards) {
        rows.push({ index: row[indexField] ?? 0, event: forwardEvent(row) });
      }
    }
    rows.sort((a, b) => a.index - b.index);
    for (const row of rows) {
      if (row.index <= last) continue;
      last = row.index;
      if (row.event) push({ event: row.event, key: w.key, value: row.index });
    }
    // Rows deleted since (autoclean) leave a gap: move on to what `wait` reported.
    if (rows.length < LIST_BATCH) last = Math.max(last, reached);
  }
}

async function watchBlocks(call: Call, from: number, signal: AbortSignal, push: (item: Item) => void): Promise<void> {
  let last = from;
  while (!signal.aborted) {
    let height: number;
    try {
      height = parse(
        WaitBlockHeight,
        await call(
          'waitblockheight',
          { blockheight: last + 1, timeout: BLOCK_WAIT_SECONDS },
          { timeoutMs: (BLOCK_WAIT_SECONDS + 30) * 1000, signal },
        ),
      ).blockheight;
    } catch (err) {
      if (isTimeout(err) && !signal.aborted) continue;
      throw err;
    }
    if (height <= last) continue;
    last = height;
    push({ event: { type: 'block.new', data: { height } }, key: 'block', value: height });
  }
}
