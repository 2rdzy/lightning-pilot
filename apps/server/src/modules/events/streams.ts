import { AppError } from '@lightning-pilot/core';
import type { AuthService } from '../auth/index.ts';
import { EventBus, EVENT_LIMIT, encodeEvent } from './bus.ts';

export class EventStreams {
  readonly #auth: AuthService;
  readonly #bus: EventBus;
  readonly #heartbeatMs: number;
  readonly #connections = new Set<() => void>();
  readonly #checks = new Set<Promise<void>>();
  readonly #registrations = new Set<Promise<() => void>>();
  #stopped = false;
  constructor(auth: AuthService, bus: EventBus, heartbeatMs = 15_000) {
    this.#auth = auth;
    this.#bus = bus;
    this.#heartbeatMs = heartbeatMs;
  }

  async open(
    cookie: string,
    handle: string,
    signal: AbortSignal,
    lastId?: string,
  ): Promise<ReadableStream<Uint8Array>> {
    if (this.#stopped) throw new AppError('busy', 'The event service is stopping.', { retryAfter: 1 });
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let demand = false;
    let closed = false;
    let cancelled = false;
    let ending: 'logout' | 'revoked' | 'expired' | undefined;
    let queue: string[] = [];
    let unregister = () => {};
    let unsubscribe = () => {};
    let offEnd = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    let checking = false;
    const cleanup = () => {
      if (timer) clearInterval(timer);
      unregister();
      unsubscribe();
      signal.removeEventListener('abort', abort);
      this.#connections.delete(close);
      queue = [];
    };
    const close = () => {
      if (closed) return;
      closed = true;
      // Session callbacks close first, then announce the reason synchronously. Defer only the final frame;
      // discard queued private data immediately, including on a slow connection.
      cleanup();
      queueMicrotask(() => {
        offEnd();
        if (cancelled) return;
        if (ending)
          controller.enqueue(encoder.encode(encodeEvent(this.#bus.make('session.ending', { reason: ending }))));
        controller.close();
      });
    };
    const abort = () => {
      cancelled = true;
      if (!closed) {
        closed = true;
        cleanup();
        offEnd();
        controller.close();
      }
    };
    const enqueue = (frame: string) => {
      if (closed) return;
      if (demand) {
        demand = false;
        controller.enqueue(encoder.encode(frame));
      } else if (queue.length < EVENT_LIMIT) queue.push(frame);
      else close();
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        pull(c) {
          const frame = queue.shift();
          if (frame !== undefined) c.enqueue(encoder.encode(frame));
          else demand = true;
        },
        cancel() {
          cancelled = true;
          if (!closed) {
            closed = true;
            cleanup();
            offEnd();
          }
        },
      },
      { highWaterMark: 0 },
    );
    this.#connections.add(close);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const registering = this.#auth.sessions.registerStream(cookie, close);
      this.#registrations.add(registering);
      try {
        unregister = await registering;
      } finally {
        this.#registrations.delete(registering);
      }
      // Revocation/abort can run while registration yields; unregister the returned handle in that case.
      if (closed || signal.aborted || this.#stopped) {
        unregister();
        if (!closed) {
          if (signal.aborted) abort();
          else close();
        }
        return stream;
      }
      offEnd = this.#auth.sessions.onEnd((endedHandle, reason) => {
        if (endedHandle === handle) ending = reason === 'logout' || reason === 'expired' ? reason : 'revoked';
      });
      // Replay and subscription are synchronous: publication cannot interleave between them.
      const replay = this.#bus.replay(lastId);
      for (const event of replay) enqueue(encodeEvent(event));
      unsubscribe = this.#bus.subscribe((event) => enqueue(encodeEvent(event)));
      timer = setInterval(() => {
        if (checking || closed) return;
        checking = true;
        const check = this.#auth.sessions
          .streamSession(handle)
          .then((session) => {
            if (!session) close();
            else enqueue(': heartbeat\n\n');
          })
          .catch(close)
          .finally(() => {
            checking = false;
            this.#checks.delete(check);
          });
        this.#checks.add(check);
      }, this.#heartbeatMs);
      timer.unref();
      if (replay.length === 0) enqueue(': connected\n\n');
      return stream;
    } catch (err) {
      close();
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const close of [...this.#connections]) close();
    await Promise.allSettled([...this.#registrations]);
    await Promise.allSettled([...this.#checks]);
  }
}
