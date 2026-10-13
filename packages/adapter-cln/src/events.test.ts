// The wait-based event stream with a scripted node: `wait` and `waitblockheight` block until the test answers them.
import { describe, expect, it } from 'vitest';
import { AdapterError, type EventCursor, type NodeEvent } from '@lightning-pilot/core';
import { createClnAdapter } from './adapter.ts';
import type { Transport } from './context.ts';
import { decodeCursor, encodeCursor } from './events.ts';
import { getinfo, HASH } from './fixtures/recorded.ts';

type Lists = Record<string, (params: Record<string, unknown>) => unknown>;

// `wait` with nextvalue 0 answers the current index (10) at once; any other `wait`, and `waitblockheight`, waits
// for an answer queued with `answer(key, value)` (key `invoices:updated`, …, or `block`), or fails when aborted.
function scripted(lists: Lists = {}) {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  const queues = new Map<string, unknown[]>();
  const waiters = new Map<string, () => void>();
  const pending = (key: string, signal: AbortSignal | undefined) =>
    new Promise((resolve, reject) => {
      const take = () => {
        const next = queues.get(key)?.shift();
        if (next === undefined) return false;
        waiters.delete(key);
        if (next instanceof Error) reject(next);
        else resolve(next);
        return true;
      };
      if (take()) return;
      waiters.set(key, () => void take());
      signal?.addEventListener('abort', () =>
        reject(new AdapterError({ code: 'node_unreachable', sent: true, definitive: false, detail: 'aborted' })),
      );
    });
  const transport: Transport = {
    call: async (command, params, options) => {
      calls.push({ command, params });
      if (command === 'getinfo') return JSON.parse(getinfo());
      if (command === 'wait') {
        if (params.nextvalue === 0) return { subsystem: params.subsystem, [String(params.indexname)]: 10 };
        return pending(`${String(params.subsystem)}:${String(params.indexname)}`, options.signal);
      }
      if (command === 'waitblockheight') return pending('block', options.signal);
      const list = lists[command];
      if (list) return list(params);
      throw new Error(`unexpected ${command}`);
    },
  };
  const answer = (key: string, value: unknown) => {
    queues.set(key, [...(queues.get(key) ?? []), value]);
    waiters.get(key)?.();
  };
  const adapter = createClnAdapter({
    url: 'https://localhost:1',
    caCertificate: '',
    serverName: 'x',
    viewRune: 'V',
    transport,
  });
  return { adapter, calls, answer };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function next(iterator: AsyncIterator<{ event: NodeEvent; cursor: EventCursor }>) {
  const result = await iterator.next();
  if (result.done) throw new Error('stream ended');
  return result.value;
}

describe('event cursor', () => {
  it('round-trips and refuses anything else', () => {
    const state = {
      'invoices.updated': 1,
      'sendpays.created': 2,
      'sendpays.updated': 3,
      'forwards.created': 4,
      'forwards.updated': 5,
      block: 126,
    };
    expect(encodeCursor(state)).toBe('cln1.1.2.3.4.5.126');
    expect(decodeCursor('cln1.1.2.3.4.5.126')).toEqual(state);
    for (const bad of ['', 'cln1.1.2.3', 'cln2.1.2.3.4.5.6', 'cln1.1.2.3.4.5.x', 'fake.1']) {
      expect(() => decodeCursor(bad), bad).toThrow(AdapterError);
    }
  });
});

describe('event stream', () => {
  it('starts at the present, reads changed rows from the last index, and yields resume cursors', async () => {
    const s = scripted({
      listinvoices: (p) => ({
        invoices:
          p.start === 11
            ? [
                {
                  label: 'l3',
                  payment_hash: HASH,
                  status: 'expired',
                  expires_at: 1,
                  created_index: 5,
                  updated_index: 13,
                },
                {
                  label: 'l1',
                  payment_hash: HASH,
                  status: 'paid',
                  expires_at: 1,
                  created_index: 3,
                  updated_index: 11,
                  amount_received_msat: 5000n,
                },
                {
                  label: 'l2',
                  payment_hash: HASH,
                  status: 'unpaid',
                  expires_at: 1,
                  created_index: 4,
                  updated_index: 12,
                },
              ]
            : [],
      }),
    });
    const controller = new AbortController();
    const iterator = s.adapter.events.subscribe(undefined, controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    await tick();
    s.answer('invoices:updated', { subsystem: 'invoices', updated: 13 });
    const paid = await first;
    expect(paid.done).toBe(false);
    expect(paid.value?.event).toEqual({
      type: 'invoice.paid',
      data: { paymentHash: HASH, amountReceived: 5000n, label: 'l1' },
    });
    expect(paid.value?.cursor).toBe('cln1.11.10.10.10.10.126');
    const expired = await next(iterator);
    expect(expired.event).toEqual({ type: 'invoice.expired', data: { paymentHash: HASH, label: 'l3' } });
    expect(expired.cursor).toBe('cln1.13.10.10.10.10.126');
    expect(s.calls.find((c) => c.command === 'listinvoices')?.params).toEqual({
      index: 'updated',
      start: 11,
      limit: 100,
    });

    s.answer('block', { blockheight: 128 });
    expect(await next(iterator)).toEqual({
      event: { type: 'block.new', data: { height: 128 } },
      cursor: 'cln1.13.10.10.10.10.128',
    });
    expect(s.calls.find((c) => c.command === 'waitblockheight')?.params).toEqual({ blockheight: 127, timeout: 60 });
    // The next invoices wait starts after the last row read.
    expect(
      s.calls.filter((c) => c.command === 'wait' && c.params.subsystem === 'invoices').map((c) => c.params.nextvalue),
    ).toEqual([0, 11, 14]);
    controller.abort();
    expect((await iterator.next()).done).toBe(true);
  });

  it('resumes from a cursor: payments with their fee, forwards, and nothing for unknown statuses', async () => {
    const s = scripted({
      listsendpays: (p) => ({
        payments:
          p.index === 'created'
            ? [
                { payment_hash: HASH, status: 'pending', created_index: 21, amount_msat: 1000n },
                { payment_hash: HASH, status: 'strange', created_index: 22 },
              ]
            : [
                {
                  payment_hash: HASH,
                  status: 'complete',
                  created_index: 21,
                  updated_index: 31,
                  amount_msat: 1000n,
                  amount_sent_msat: 1003n,
                },
              ],
      }),
      listforwards: () => ({
        forwards: [{ created_index: 41, in_channel: '1x1x0', in_msat: 1010n, status: 'offered', received_time: 1 }],
      }),
    });
    const iterator = s.adapter.events.subscribe('cln1.0.20.30.40.50.126')[Symbol.asyncIterator]();
    const first = iterator.next();
    await tick();
    s.answer('sendpays:created', { subsystem: 'sendpays', created: 22 });
    expect((await first).value?.event).toEqual({
      type: 'payment.updated',
      data: { paymentHash: HASH, status: 'pending' },
    });
    s.answer('sendpays:updated', { subsystem: 'sendpays', updated: 31 });
    const done = await next(iterator);
    expect(done.event).toEqual({
      type: 'payment.updated',
      data: { paymentHash: HASH, status: 'succeeded', amountSent: 1003n, fee: 3n },
    });
    expect(done.cursor).toBe('cln1.0.21.31.40.50.126');
    s.answer('forwards:created', { subsystem: 'forwards', created: 41 });
    const forward = await next(iterator);
    expect(forward.event).toMatchObject({ type: 'forward.updated', data: { inChannel: '1x1x0', status: 'offered' } });
    expect(forward.cursor).toBe('cln1.0.21.31.41.50.126');
    // No call asked for the present: the cursor said where to start.
    expect(s.calls.some((c) => c.command === 'wait' && c.params.nextvalue === 0)).toBe(false);
    await iterator.return?.();
  });

  it('asks again after a timeout, skips rows deleted meanwhile, and ends with the error of a failed watch', async () => {
    const s = scripted({ listforwards: () => ({ forwards: [] }) });
    const iterator = s.adapter.events.subscribe('cln1.0.0.0.0.0.126')[Symbol.asyncIterator]();
    const result = iterator.next();
    await tick();
    s.answer('block', new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: 2000 }));
    s.answer(
      'forwards:updated',
      new AdapterError({ code: 'node_unreachable', sent: true, definitive: false, detail: 'timeout' }),
    );
    await tick();
    await tick();
    // Rows 1–5 were deleted (autoclean): the watch moves on to what `wait` reported.
    s.answer('forwards:updated', { subsystem: 'forwards', updated: 5 });
    await tick();
    await tick();
    s.answer('block', { blockheight: 126 });
    s.answer('block', { blockheight: 127 });
    expect((await result).value?.event).toEqual({ type: 'block.new', data: { height: 127 } });
    const nextValues = s.calls
      .filter((c) => c.command === 'wait' && c.params.subsystem === 'forwards' && c.params.indexname === 'updated')
      .map((c) => c.params.nextvalue);
    expect(nextValues).toEqual([1, 1, 6]);
    s.answer('invoices:updated', new AdapterError({ code: 'node_credential_revoked', sent: true, definitive: true }));
    await expect(iterator.next()).rejects.toMatchObject({ code: 'node_credential_revoked' });
  });

  it('refuses a malformed cursor and stops at once when already aborted', async () => {
    const s = scripted();
    await expect(s.adapter.events.subscribe('nonsense')[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      sent: false,
    });
    const controller = new AbortController();
    controller.abort();
    const iterator = s.adapter.events.subscribe('cln1.0.0.0.0.0.1', controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(true);
  });
});
