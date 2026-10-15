import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createClnAdapter } from '../../packages/adapter-cln/src/index.ts';
import { apiSession, ok } from './api-session.ts';
import { cli, invoiceOn, payOn, regtest, regtestChain, nodeUri } from './nodes.ts';
import type { LiveEvent } from '../../apps/server/src/modules/events/index.ts';

const chain = regtestChain();
if (!chain) throw new Error('set LP_REGTEST_CHAIN to blake2b or sha256d');

it(`delivers invoice, payment, channel and block SSE events on ${chain}; closes on logout and detects restart`, async () => {
  const s = await apiSession(chain);
  const events: LiveEvent[] = [];
  let pump: Promise<void> | undefined;
  try {
    let subscribed = false;
    await s.reopen({
      eventIntervalMs: 100,
      adapterFactory: (connection) =>
        createClnAdapter({
          ...connection,
          onCall: (method) => {
            if (method === 'waitblockheight') subscribed = true;
          },
        }),
    });
    const response = await s.request('GET', '/api/v1/events');
    expect(response.status).toBe(200);
    if (!response.body) throw new Error('Missing SSE body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    pump = (async () => {
      let buffer = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)) as LiveEvent);
        }
      }
    })();
    s.server.events.workers.start();
    await expect.poll(() => events.some((e) => e.type === 'channel.updated'), { timeout: 20_000 }).toBe(true);
    // Initial snapshots can finish before the adapter has read its starting indexes.
    await expect.poll(() => subscribed, { timeout: 20_000 }).toBe(true);
    // First block establishes a handled cursor before making the payments.
    regtest(chain, 'mine', '1');
    await expect.poll(() => events.some((e) => e.type === 'block.new'), { timeout: 60_000 }).toBe(true);
    const suffix = randomBytes(6).toString('hex');
    const incoming = await ok<{ bolt11: string; paymentHash: string }>(
      await s.request('POST', `/api/v1/nodes/${s.nodeId}/invoices`, {
        amount: '10000',
        description: 'events',
      }),
      201,
    );
    payOn(chain, 'cln-c', incoming.bolt11);
    await expect
      .poll(() => events.some((e) => e.type === 'invoice.paid' && e.data.paymentHash === incoming.paymentHash), {
        timeout: 20_000,
      })
      .toBe(true);
    const outgoing = invoiceOn(chain, 'cln-c', 10000n, `events-out-${suffix}`);
    // This is an external payment; the event worker observes it through the read credential.
    payOn(chain, 'cln-a', outgoing);
    await expect.poll(() => events.some((e) => e.type === 'payment.updated'), { timeout: 20_000 }).toBe(true);
    const id = events.find((e) => e.type === 'channel.updated');
    if (!id || id.type !== 'channel.updated') throw new Error('Missing channel event');
    // A real channel transition, rather than only its initial snapshot.
    const peer = nodeUri(chain, 'cln-c');
    cli(chain, 'cln-a', 'disconnect', peer.pubkey, 'true');
    await expect
      .poll(() => events.some((e) => e.type === 'channel.updated' && e.data.state.group === 'inactive'), {
        timeout: 20_000,
      })
      .toBe(true);
    cli(chain, 'cln-a', 'connect', peer.uri);
    await expect
      .poll(() => events.filter((e) => e.type === 'channel.updated' && e.data.state.group === 'active').length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(2);
    expect(await s.server.db.selectFrom('event_cursors').selectAll().execute()).toHaveLength(1);
    // Closing the server drains the old transport. The session remains valid across the restart.
    await s.reopen();
    await pump;
    const reconnected = await s.request('GET', '/api/v1/events', undefined, { 'last-event-id': id.id });
    if (!reconnected.body) throw new Error('Missing reconnected SSE body');
    const resumed = reconnected.body.getReader();
    expect(new TextDecoder().decode((await resumed.read()).value)).toContain('"reason":"restart"');
    await ok(await s.request('POST', '/api/v1/auth/logout'), 204);
    expect(new TextDecoder().decode((await resumed.read()).value)).toContain('session.ending');
    expect((await resumed.read()).done).toBe(true);
  } finally {
    await s.cleanup();
    await pump;
    // Restore peer connectivity if an assertion failed after disconnecting it.
    cli(chain, 'cln-a', 'connect', nodeUri(chain, 'cln-c').uri);
  }
});
