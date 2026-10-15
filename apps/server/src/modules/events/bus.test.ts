import { describe, expect, it } from 'vitest';
import { parsePubkey } from '@lightning-pilot/core';
import { EventBus, EVENT_LIMIT, encodeEvent } from './bus.ts';
import { eventDocumentation } from './schemas.ts';

const node = { chain: 'bitcoin', network: 'regtest', pubkey: parsePubkey('02' + '11'.repeat(32)) } as const;
describe('event envelope and replay', () => {
  it('validates, strips undeclared data, serializes msat exactly and documents every type', () => {
    const bus = new EventBus(() => new Date('2026-10-15T00:00:00Z'));
    const event = bus.publish(
      'invoice.paid',
      { paymentHash: '11'.repeat(32), amountReceived: 9007199254740993123n, label: 'a\nb', preimage: 'secret' },
      node,
    );
    expect(event).toMatchObject({
      at: '2026-10-15T00:00:00.000Z',
      node,
      data: { amountReceived: '9007199254740993123' },
    });
    expect(event.data).not.toHaveProperty('preimage');
    expect(encodeEvent(event).split('\n')).toHaveLength(5);
    expect(() => bus.publish('block.new', { height: -1 })).toThrow();
    expect(() => bus.publish('invoice.expired', { paymentHash: '11'.repeat(32), label: 'x'.repeat(5000) })).toThrow();
    expect(Object.keys(eventDocumentation())).toContain('chain_identity.updated');
  });
  it('replays a retained suffix; listener failure does not starve other subscribers', () => {
    const bus = new EventBus();
    bus.subscribe(() => {
      throw new Error('subscriber');
    });
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(e.id));
    const first = bus.publish('block.new', { height: 1 });
    const second = bus.publish('block.new', { height: 2 });
    off();
    bus.publish('block.new', { height: 3 });
    expect(seen).toEqual([first.id, second.id]);
    expect(bus.replay(first.id).map((e) => e.data)).toEqual([{ height: 2 }, { height: 3 }]);
    expect(bus.replay(undefined)).toEqual([]);
    expect(bus.replay('')).toEqual([]);
  });
  it('recognizes restart, lost history and invalid/future cursors', () => {
    const bus = new EventBus();
    const first = bus.publish('block.new', { height: 1 });
    for (let i = 0; i < EVENT_LIMIT + 1; i++) bus.publish('block.new', { height: i + 2 });
    expect(bus.replay(first.id)[0]?.data).toEqual({ reason: 'history_lost' });
    expect(new EventBus().replay(first.id)[0]?.data).toEqual({ reason: 'restart' });
    expect(bus.replay(`${bus.epoch}-999999`)[0]?.data).toEqual({ reason: 'invalid_cursor' });
    expect(bus.replay('bad\nframe')[0]?.data).toEqual({ reason: 'invalid_cursor' });
  });
});
