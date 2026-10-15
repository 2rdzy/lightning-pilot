import { AppError } from '@lightning-pilot/core';
import { writeTx, type Db, type RawDb } from '../../../storage/db.ts';
import type { Logger } from '../../../logging/logger.ts';
import { HashLane } from './lane.ts';
import {
  DEVICE_LIFETIME_MS,
  deviceDigest,
  digest,
  directSource,
  type LoginOrigin,
  type LoginSource,
} from './source.ts';

export const COUNTER_DECAY_MS = 24 * 60 * 60 * 1000;
export const UNKNOWN_COUNTER_LIMIT = 10_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_FAILURE_LIMIT = 30;
// Rows that the unknown-source cap bounds: anyone can create them by connecting from a new address.
const UNKNOWN_KINDS = ['ip', 'tor', 'setup'];
const delayMs = (failures: number) => Math.min(2 ** (failures - 1), 900) * 1000;
const tooEarly = (ms: number) =>
  new AppError('too_early', 'Wait before trying to log in again.', { retryAfter: Math.max(1, Math.ceil(ms / 1000)) });

export interface LoginAttempt {
  source: LoginSource;
  deviceCookie?: string;
  // Set by the verifier when the password matched and a second factor did not. Such a failure also counts on
  // the account-wide factor counter, which only someone who knows the password can raise.
  failedFactor?: 'totp' | 'recovery';
}

interface CounterRow {
  counter: string;
  kind: string;
  failures: number;
  next_allowed_at: number;
  last_failed_at: number;
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
      'SELECT counter, kind, failures, next_allowed_at, last_failed_at FROM login_throttles WHERE counter IN (?, ?, ?)',
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

  // A known device is checked on its own counter only: neither the global window nor the factor counter can be
  // used by someone else to lock the owner out of their own browsers.
  #allowed(source: LoginSource | { kind: 'setup'; counter: string }): void {
    this.assertOpen();
    const now = this.#now().getTime();
    const shared = source.kind === 'ip' || source.kind === 'tor';
    const rows = this.#counterLookup.all([
      source.counter,
      shared ? 'global' : source.counter,
      shared ? 'factor' : source.counter,
    ]) as CounterRow[];
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

  async prune(db: Db): Promise<number> {
    const before = await db
      .selectFrom('login_throttles')
      .select(db.fn.count<number>('counter').as('count'))
      .executeTakeFirstOrThrow();
    await this.#prune(db, this.#now().getTime());
    const after = await db
      .selectFrom('login_throttles')
      .select(db.fn.count<number>('counter').as('count'))
      .executeTakeFirstOrThrow();
    return before.count - after.count;
  }
  // One failure on one counter: the doubling delay, decayed after a day without failures.
  async #record(db: Db, counter: string, kind: string, now: number): Promise<void> {
    const row = await db.selectFrom('login_throttles').selectAll().where('counter', '=', counter).executeTakeFirst();
    const failures = Math.min(11, (row && row.last_failed_at > now - COUNTER_DECAY_MS ? row.failures : 0) + 1);
    const values = { counter, kind, failures, next_allowed_at: now + delayMs(failures), last_failed_at: now };
    await db
      .insertInto('login_throttles')
      .values(values)
      .onConflict((oc) => oc.column('counter').doUpdateSet(values))
      .execute();
  }

  async #capUnknown(db: Db): Promise<void> {
    const count = await db
      .selectFrom('login_throttles')
      .select(db.fn.count<number>('counter').as('count'))
      .where('kind', 'in', UNKNOWN_KINDS)
      .executeTakeFirstOrThrow();
    const excess = count.count - UNKNOWN_COUNTER_LIMIT;
    if (excess <= 0) return;
    const oldest = await db
      .selectFrom('login_throttles')
      .select('counter')
      .where('kind', 'in', UNKNOWN_KINDS)
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

  async #failed(attempt: LoginAttempt): Promise<void> {
    const { source } = attempt;
    await writeTx(this.#db, async (db) => {
      const now = this.#now().getTime();
      await this.#prune(db, now);
      await this.#record(db, source.counter, source.kind, now);
      if (source.kind !== 'device') {
        if (attempt.failedFactor) await this.#record(db, 'factor', 'factor', now);
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
      await this.#capUnknown(db);
    });
  }

  // Both factors were right: the source's own counter and the account's factor counter start again.
  async succeeded(db: Db, source: LoginSource): Promise<void> {
    await this.#prune(db, this.#now().getTime());
    await db.deleteFrom('login_throttles').where('counter', 'in', [source.counter, 'factor']).execute();
  }

  // A wrong TOTP code at security step-up (the password matched) is a factor guess too. Step-up counts it here but
  // does not wait on this counter: someone who knows the password could otherwise keep the owner from the security
  // step-up needed to change that password. Step-up has its own per-session delay and revocation instead.
  async factorFailed(db: Db): Promise<void> {
    const now = this.#now().getTime();
    await this.#prune(db, now);
    await this.#record(db, 'factor', 'factor', now);
  }

  // A complete password + TOTP step-up clears the account's factor counter, like a complete login.
  async factorSucceeded(db: Db): Promise<void> {
    await db.deleteFrom('login_throttles').where('counter', '=', 'factor').execute();
  }

  // Setup-token checks use the login source identity (IPv6 /64, trusted proxies, Tor listener) with their own
  // persisted counters. The check is cheap, so it needs a claim but no hash lane.
  // verify returns the matched value, or undefined for a wrong token.
  async setup<T>(origin: LoginOrigin, requestId: string, verify: () => Promise<T | undefined>): Promise<T> {
    this.assertOpen();
    const direct = directSource(origin, this.#trustedProxies);
    const source = { kind: 'setup' as const, counter: `setup:${digest(direct.descriptor)}` };
    if (this.#claims.has(source.counter)) throw tooEarly(1000);
    this.#allowed(source);
    this.#claims.add(source.counter);
    try {
      const verified = await verify();
      if (verified !== undefined) {
        await this.#db.deleteFrom('login_throttles').where('counter', '=', source.counter).execute();
        return verified;
      }
      await writeTx(this.#db, async (db) => {
        const now = this.#now().getTime();
        await this.#prune(db, now);
        await this.#record(db, source.counter, source.kind, now);
        await this.#capUnknown(db);
      });
      this.#log.warn('setup token refused', {
        requestId,
        security: true,
        sourceKind: direct.kind,
        source: direct.descriptor,
      });
      throw new AppError('setup_token_invalid', 'The setup token is not valid.');
    } finally {
      this.#claims.delete(source.counter);
      if (this.#claims.size === 0) this.#drained?.();
    }
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
        if (err instanceof AppError && err.code === 'login_failed') await this.#failed(attempt);
        throw err;
      } finally {
        this.#claims.delete(source.counter);
        ticket.release();
        if (this.#claims.size === 0) this.#drained?.();
      }
    } catch (err) {
      // Only checked guesses are authentication failures. Logging every cheap rejection would turn a
      // rotating-source flood into an unbounded stdout buffer; unexpected errors reach the HTTP logger.
      if (err instanceof AppError && err.code === 'login_failed')
        this.#log.warn('login failed', attempt.failedFactor ? { ...fields, factor: attempt.failedFactor } : fields);
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
