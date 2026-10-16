// The live connection behind the top bar's indicator: one EventSource on GET /api/v1/events (WP11, read permission,
// session cookie). The browser reconnects by itself after a dropped connection (state `reconnecting`); when the
// server refuses the stream outright (401, 403, or 503 at its limit of three streams per session) the EventSource
// closes for good, and this module opens a new one after a growing delay. Events are named (`event: block.new`,
// WP11 bus.ts), so `onmessage` never fires: listeners are registered per type in `eventTypes`. The shell uses
// block.new and chain_identity.updated to refresh the height and the badge; screens that react to more events
// (WP16–WP19) add their types to the same connection, so the session keeps one stream of its three.
import type { LiveState } from '@lightning-pilot/ui';

export const EVENTS_PATH = '/api/v1/events';

// 2 s, 4 s, 8 s … at most 60 s between attempts after a refused stream.
export function retryDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt));
}

export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface LiveOptions {
  onState: (state: LiveState) => void;
  eventTypes?: readonly string[];
  onEvent?: (type: string, event: MessageEvent) => void;
  open?: (url: string) => EventSourceLike;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const CLOSED = 2;

// Starts the connection; the returned function stops it (on logout, and when the shell unmounts).
export function connectLive(options: LiveOptions): () => void {
  const open = options.open ?? ((url) => new EventSource(url));
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let source: EventSourceLike | undefined;
  let timer: unknown;
  let attempt = 0;
  let stopped = false;

  const start = () => {
    timer = undefined;
    if (stopped) return;
    const current = open(EVENTS_PATH);
    source = current;
    current.onopen = () => {
      attempt = 0;
      options.onState('live');
    };
    for (const type of options.eventTypes ?? []) {
      current.addEventListener(type, (event) => {
        if (!stopped && source === current) options.onEvent?.(type, event);
      });
    }
    current.onerror = () => {
      if (stopped || source !== current) return;
      options.onState('reconnecting');
      if (current.readyState === CLOSED) {
        current.close();
        timer = setTimer(start, retryDelay(attempt++));
      }
    };
  };

  options.onState('connecting');
  start();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
    source?.close();
    source = undefined;
  };
}
