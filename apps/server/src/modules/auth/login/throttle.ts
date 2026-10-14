import { AppError } from '@lightning-pilot/core';
import { writeTx, type Db, type RawDb } from '../../../storage/db.ts';
import type { Logger } from '../../../logging/logger.ts';
import { HashLane } from './lane.ts';
import { DEVICE_LIFETIME_MS, deviceDigest, directSource, type LoginOrigin, type LoginSource } from './source.ts';

export const COUNTER_DECAY_MS = 24 * 60 * 60 * 1000;
export const UNKNOWN_COUNTER_LIMIT = 10_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_FAILURE_LIMIT = 30;
const tooEarly = (ms: number) =>
  new AppError('too_early', 'Wait before trying to log in again.', { retryAfter: Math.max(1, Math.ceil(ms / 1000)) });

export interface LoginAttempt {
  source: LoginSource;
  deviceCookie?: string;
}

export class LoginThrottle {
  readonly #db: Db;
  readonly #log: Logger;
  readonly #deviceLookup: ReturnType<RawDb['prepare']>;
  readonly #counterLookup: ReturnType<RawDb['prepare']>;
  readonly #now: () => Date;
  readonly #trustedProxies: readonly string[];
  readonly #known = new HashLane();
  readonly #unknown = new HashLane();
  readonly #claims = new Set<string>();
  #closed = false;
  #drained: (() => void) | undefined;
  #closing: Promise<void> | undefined;

  constructor(options: { db: Db; raw: RawDb; now: () => Date; trustedProxies: readonly string[]; logger: Logger }) {
    this.#db = options.db;
    this.#log = options.logger.child('auth.login');
    // Reuse two statements: rejected floods must not allocate native prepared statements per request.
    this.#deviceLookup = options.raw.prepare(
      'SELECT id_hash FROM known_devices WHERE id_hash = ? AND expires_at > ? AND last_seen_at > ?',
    );
    this.#counterLookup = options.raw.prepare(
      'SELECT kind, failures, next_allowed_at, last_failed_at FROM login_throttles WHERE counter = ? OR counter = ?',
    );
    this.#now = options.now;
    this.#trustedProxies = options.trustedProxies;
  }

  assertOpen(): void {
    if (this.#closed) throw new AppError('busy', 'Login is stopping.', { retryAfter: 1 });
  }

  // Synchronous, small, indexed lookup before any async admission: a flood of fabricated cookies must not
  // create unlimited Kysely waiters or reserve the owner's known-device lane.
  #identify(origin: LoginOrigin, cookie?: string): LoginAttempt {
    const hash = deviceDigest(cookie);
    const now = this.#now();
    if (
      cookie &&
      hash &&
      this.#deviceLookup.all([hash, now.toISOString(), new Date(now.getTime() - DEVICE_LIFETIME_MS).toISOString()])
        .length > 0
    ) {
      return {
        source: { kind: 'device', counter: `device:${hash}`, descriptor: `device:${hash}` },
        deviceCookie: cookie,
      };
    }
    return { source: directSource(origin, this.#trustedProxies) };
  }

  #allowed(source: LoginSource): void {
    this.assertOpen();
    const now = this.#now().getTime();
    const rows = this.#counterLookup.all([source.counter, source.kind === 'device' ? source.counter : 'global']) as {
      kind: string;
      failures: number;
      next_allowed_at: number;
      last_failed_at: number;
    }[];
    let wait = 0;
    for (const row of rows) {
      if (row.kind === 'global' ? row.failures >= GLOBAL_FAILURE_LIMIT : row.last_failed_at > now - COUNTER_DECAY_MS) {
        wait = Math.max(wait, row.next_allowed_at - now);
      }
    }
    if (wait > 0) throw tooEarly(wait);
  }

  async #prune(db: Db, now: number): Promise<void> {
    await db
      .deleteFrom('login_throttles')
      .where('kind', '!=', 'global')
      .where('last_failed_at', '<=', now - COUNTER_DECAY_MS)
      .where('counter', 'not in', [...this.#claims])
      .execute();
    await db.deleteFrom('login_throttles').where('kind', '=', 'global').where('next_allowed_at', '<=', now).execute();
  }

  async #failed(source: LoginSource): Promise<void> {
    await writeTx(this.#db, async (db) => {
      const now = this.#now().getTime();
      await this.#prune(db, now);
      const row = await db
        .selectFrom('login_throttles')
        .selectAll()
        .where('counter', '=', source.counter)
        .executeTakeFirst();
      const failures = Math.min(11, (row && row.last_failed_at > now - COUNTER_DECAY_MS ? row.failures : 0) + 1);
      const values = {
        counter: source.counter,
        kind: source.kind,
        failures,
        next_allowed_at: now + Math.min(2 ** (failures - 1), 900) * 1000,
        last_failed_at: now,
      };
      await db
        .insertInto('login_throttles')
        .values(values)
        .onConflict((oc) => oc.column('counter').doUpdateSet(values))
        .execute();
      if (source.kind !== 'device') {
        const global = await db
          .selectFrom('login_throttles')
          .selectAll()
          .where('counter', '=', 'global')
          .executeTakeFirst();
        const window = {
          counter: 'global',
          kind: 'global',
          failures: Math.min(33, (global?.failures ?? 0) + 1),
          next_allowed_at: global?.next_allowed_at ?? now + GLOBAL_WINDOW_MS,
          last_failed_at: now,
        };
        await db
          .insertInto('login_throttles')
          .values(window)
          .onConflict((oc) => oc.column('counter').doUpdateSet(window))
          .execute();
      }
      const count = await db
        .selectFrom('login_throttles')
        .select(db.fn.count<number>('counter').as('count'))
        .where('kind', 'in', ['ip', 'tor'])
        .executeTakeFirstOrThrow();
      const excess = count.count - UNKNOWN_COUNTER_LIMIT;
      if (excess > 0) {
        const oldest = await db
          .selectFrom('login_throttles')
          .select('counter')
          .where('kind', 'in', ['ip', 'tor'])
          .where('counter', 'not in', [...this.#claims])
          .orderBy('last_failed_at')
          .orderBy('counter')
          .limit(excess)
          .execute();
        await db
          .deleteFrom('login_throttles')
          .where(
            'counter',
            'in',
            oldest.map((entry) => entry.counter),
          )
          .execute();
      }
    });
  }

  async succeeded(db: Db, source: LoginSource): Promise<void> {
    await this.#prune(db, this.#now().getTime());
    await db.deleteFrom('login_throttles').where('counter', '=', source.counter).execute();
  }

  async run<T>(
    origin: LoginOrigin,
    cookie: string | undefined,
    requestId: string,
    authenticate: (attempt: LoginAttempt) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    const attempt = this.#identify(origin, cookie);
    const { source } = attempt;
    const fields = {
      requestId,
      security: true,
      sourceKind: source.kind,
      source: source.descriptor,
      counter: source.counter,
    };
    try {
      if (this.#claims.has(source.counter)) throw tooEarly(1000);
      this.#allowed(source);
      const ticket = (source.kind === 'device' ? this.#known : this.#unknown).reserve();
      this.#claims.add(source.counter);
      try {
        await ticket.ready;
        // A queued unknown attempt may have crossed the global limit while it waited.
        this.#allowed(source);
        this.assertOpen();
        const result = await authenticate(attempt);
        this.#log.info('login succeeded', fields);
        return result;
      } catch (err) {
        if (err instanceof AppError && err.code === 'login_failed') await this.#failed(source);
        throw err;
      } finally {
        this.#claims.delete(source.counter);
        ticket.release();
        if (this.#claims.size === 0) this.#drained?.();
      }
    } catch (err) {
      // Only checked guesses are authentication failures. Logging every cheap rejection would turn a
      // rotating-source flood into an unbounded stdout buffer; unexpected errors reach the HTTP logger.
      if (err instanceof AppError && err.code === 'login_failed') this.#log.warn('login failed', fields);
      throw err;
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#known.close();
    this.#unknown.close();
    this.#closing =
      this.#claims.size === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            this.#drained = resolve;
          });
    return this.#closing;
  }
}
