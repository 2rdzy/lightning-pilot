import { AppError } from '@lightning-pilot/core';

const busy = () => new AppError('busy', 'Login is busy. Try again shortly.', { retryAfter: 1 });

interface Ticket {
  ready: Promise<void>;
  start(): void;
  reject(reason: AppError): void;
  release(): void;
}

// Reservations include callers still reading their counter: that database work cannot become an unbounded
// queue in front of the expensive checks. Exactly one reserved ticket may run; the other two wait.
export class HashLane {
  readonly #tickets: Ticket[] = [];
  #closed = false;

  reserve(): Ticket {
    if (this.#closed || this.#tickets.length >= 3) throw busy();
    let start: () => void = () => {};
    let reject: (reason: AppError) => void = () => {};
    const ready = new Promise<void>((resolve, fail) => {
      start = resolve;
      reject = fail;
    });
    // Shutdown can reject a ticket while its counter read is still awaited. The caller observes the original
    // promise below; attaching a handler now avoids a transient unhandled rejection in that interval.
    void ready.catch(() => {});
    const ticket: Ticket = {
      ready,
      start,
      reject,
      release: () => {
        const index = this.#tickets.indexOf(ticket);
        this.#tickets.splice(index, 1);
        if (index === 0 && !this.#closed) this.#tickets[0]?.start();
      },
    };
    this.#tickets.push(ticket);
    if (this.#tickets.length === 1) start();
    return ticket;
  }

  close(): void {
    this.#closed = true;
    // The running scrypt cannot be cancelled; its owner drains it before closing the database/vault.
    for (const ticket of this.#tickets.slice(1)) ticket.reject(busy());
  }
}
