import { randomBytes } from 'node:crypto';
import type { NodeRef } from '@lightning-pilot/core';
import { EVENT_SCHEMAS, EventNode, wire, type EventType, type LiveEvent } from './schemas.ts';

export const EVENT_LIMIT = 1000;
export const MAX_EVENT_BYTES = 64 * 1024;
export const encodeEvent = (event: LiveEvent): string =>
  `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export class EventBus {
  readonly epoch = randomBytes(12).toString('hex');
  readonly #now: () => Date;
  readonly #history: LiveEvent[] = [];
  readonly #listeners = new Set<(event: LiveEvent) => void>();
  #seq = 0;
  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  // Controls for one connection get unique ids but are never replayed into another session.
  make(type: EventType, data: unknown, node?: NodeRef): LiveEvent {
    const event = {
      id: `${this.epoch}-${++this.#seq}`,
      at: this.#now().toISOString(),
      type,
      data: EVENT_SCHEMAS[type].parse(wire(data)),
      ...(node ? { node: EventNode.parse(node) } : {}),
    } as LiveEvent;
    if (Buffer.byteLength(encodeEvent(event)) > MAX_EVENT_BYTES) throw new Error('Event exceeds the wire size limit');
    return event;
  }

  publish(type: EventType, data: unknown, node?: NodeRef): LiveEvent {
    const event = this.make(type, data, node);
    this.#history.push(event);
    if (this.#history.length > EVENT_LIMIT) this.#history.shift();
    // A failing listener cannot prevent ingestion progress or another subscriber's delivery.
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* Subscriber owns its failure. */
      }
    }
    return event;
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  replay(cursor: string | undefined): LiveEvent[] {
    if (cursor === undefined || cursor === '') return [];
    const match = /^([a-f0-9]{24})-([1-9][0-9]{0,15})$/.exec(cursor);
    const seq = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(seq)) return [this.make('reload', { reason: 'invalid_cursor' })];
    if (match[1] !== this.epoch) return [this.make('reload', { reason: 'restart' })];
    if (seq > this.#seq) return [this.make('reload', { reason: 'invalid_cursor' })];
    const oldest = Number(this.#history[0]?.id.split('-')[1] ?? this.#seq + 1);
    if (seq < oldest - 1) return [this.make('reload', { reason: 'history_lost' })];
    return this.#history.filter((e) => Number(e.id.split('-')[1]) > seq);
  }
}
