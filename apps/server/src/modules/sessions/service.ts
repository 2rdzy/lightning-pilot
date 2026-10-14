import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, SessionPolicy, type StepUpStrength } from '@lightning-pilot/core';
import { writeTx, type Db } from '../../storage/db.ts';
import type { DB } from '../../storage/schema.ts';
import type { Selectable } from 'kysely';
import type { Logger } from '../../logging/logger.ts';
import { HashLane } from '../auth/login/index.ts';

type Row = Selectable<DB['sessions']>;
export type EndReason =
  'logout' | 'revoked' | 'expired' | 'everywhere' | 'recovery' | 'security_change' | 'step_up_failures';
// WP07 uses device:<cookie digest> internally for counters; public provenance must not reveal that digest.
export const publicSource = (source: string): string => (source.startsWith('device:') ? 'device' : source);
export const sessionDigest = (cookie: string) => createHash('sha256').update(cookie).digest('hex');
export const csrfTokenFor = (cookie: string) => createHash('sha256').update(`csrf|${cookie}`).digest('base64url');
const GRANT_MS = 5 * 60_000;
export interface NewSession {
  cookieValue: string;
  csrfToken: string;
  expiresAt: Date;
  recoveryRequired: boolean;
}
export interface Session {
  idHash: string;
  handle: string;
  expiresAt: Date;
  recoveryRequired: boolean;
}
// The account-wide second-factor counter of the login throttle. A wrong TOTP code at security step-up is a factor
// guess like one at login, so it is counted there too; a complete password + TOTP success clears it.
export interface FactorCounter {
  failed(db: Db): Promise<void>;
  succeeded(db: Db): Promise<void>;
}
export interface SessionsOptions {
  db: Db;
  logger: Logger;
  now?: () => Date;
  idleMs?: number;
  absoluteMs?: number;
}

export class SessionsService {
  readonly #db: Db;
  readonly #now: () => Date;
  readonly #log: Logger;
  #idle: number;
  #absolute: number;
  readonly #grants = new Map<string, { password: number; security: number }>();
  readonly #claims = new Set<string>();
  readonly #lane = new HashLane();
  readonly #running = new Set<Promise<unknown>>();
  readonly #streams = new Map<string, { close: Set<() => void>; timer: NodeJS.Timeout }>();
  readonly #ended = new Set<(handle: string, reason: EndReason) => void>();
  readonly #alerts = new Set<(handle: string) => void>();
  #closed = false;

  constructor(options: SessionsOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.logger.child('sessions');
    this.#idle = options.idleMs ?? 60 * 60_000;
    this.#absolute = options.absoluteMs ?? 7 * 24 * 60 * 60_000;
  }

  async loadPolicy(): Promise<void> {
    const setting = await this.#db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'session_policy')
      .executeTakeFirst();
    if (setting) this.#applyPolicy(SessionPolicy.parse(JSON.parse(setting.value)));
  }

  #applyPolicy(policy: { idleSeconds: number; absoluteSeconds: number }): void {
    this.#idle = policy.idleSeconds * 1000;
    this.#absolute = policy.absoluteSeconds * 1000;
  }

  async policy(idHash: string) {
    return this.authorized(idHash, 'security', async () => ({
      idleSeconds: this.#idle / 1000,
      absoluteSeconds: this.#absolute / 1000,
    }));
  }

  async changePolicy(idHash: string, input: { idleSeconds: number; absoluteSeconds: number }): Promise<void> {
    const policy = SessionPolicy.parse(input);
    await this.authorized(idHash, 'security', async (db) => {
      await db
        .insertInto('settings')
        .values({ key: 'session_policy', value: JSON.stringify(policy) })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(policy) }))
        .execute();
    });
    this.#applyPolicy(policy);
    const rows = await this.#db.selectFrom('sessions').selectAll().where('ended_at', 'is', null).execute();
    for (const row of rows) {
      if (this.#now().getTime() >= this.deadline(row)) await this.end(row.handle, 'expired');
      else this.#schedule(row);
    }
    this.#log.info('session policy changed', { security: true });
  }

  async create(db: Db, now: Date, recoveryRequired = false, source = 'unknown'): Promise<NewSession> {
    const cookieValue = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.#absolute);
    await db
      .insertInto('sessions')
      .values({
        id_hash: sessionDigest(cookieValue),
        handle: randomUUID(),
        created_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        recovery_required: recoveryRequired ? 1 : 0,
        source,
      })
      .execute();
    return { cookieValue, csrfToken: csrfTokenFor(cookieValue), expiresAt, recoveryRequired };
  }

  deadline(row: Row): number {
    return Math.min(
      Date.parse(row.expires_at),
      Date.parse(row.created_at) + this.#absolute,
      Date.parse(row.last_seen_at) + this.#idle,
    );
  }

  async live(db: Db, idHash: string): Promise<Row> {
    const row = await db.selectFrom('sessions').selectAll().where('id_hash', '=', idHash).executeTakeFirst();
    if (this.#closed || !row || row.ended_at !== null || this.#now().getTime() >= this.deadline(row))
      throw new AppError('unauthenticated', 'Please log in.');
    return row;
  }

  async session(cookie: string, activity = false): Promise<Session | undefined> {
    if (this.#closed) return undefined;
    const idHash = sessionDigest(cookie);
    const row = await this.#db.selectFrom('sessions').selectAll().where('id_hash', '=', idHash).executeTakeFirst();
    if (this.#closed || !row || row.ended_at !== null) return undefined;
    const now = this.#now();
    if (now.getTime() >= this.deadline(row)) {
      if (await this.end(row.handle, 'expired')) return undefined;
      return this.session(cookie, activity);
    }
    // Touch only after Host/Origin/authentication/CSRF checks, and only on explicit user activity.
    if (activity) {
      const updated = await writeTx(this.#db, async (db) => {
        const current = await this.live(db, idHash);
        await db
          .updateTable('sessions')
          .set({
            last_seen_at: new Date(Math.max(Date.parse(current.last_seen_at), this.#now().getTime())).toISOString(),
          })
          .where('id_hash', '=', idHash)
          .execute();
        return db.selectFrom('sessions').selectAll().where('id_hash', '=', idHash).executeTakeFirstOrThrow();
      });
      row.last_seen_at = updated.last_seen_at;
      row.expires_at = updated.expires_at;
      this.#schedule(row);
    }
    return {
      idHash,
      handle: row.handle,
      recoveryRequired: row.recovery_required === 1,
      expiresAt: new Date(this.deadline(row)),
    };
  }

  async list(current: string) {
    const rows = await this.#db.selectFrom('sessions').selectAll().orderBy('created_at', 'desc').execute();
    for (const row of rows)
      if (row.ended_at === null && this.#now().getTime() >= this.deadline(row)) {
        await this.end(row.handle, 'expired');
        const current = await this.#db
          .selectFrom('sessions')
          .selectAll()
          .where('handle', '=', row.handle)
          .executeTakeFirst();
        if (current) Object.assign(row, current);
      }
    return {
      items: rows.map((row) => ({
        id: row.handle,
        createdAt: row.created_at,
        lastUsedAt: row.last_seen_at,
        expiresAt: new Date(this.deadline(row)).toISOString(),
        source: publicSource(row.source),
        current: row.handle === current,
        endedAt: row.ended_at,
        endReason: row.end_reason,
      })),
    };
  }

  async markEnded(db: Db, handles: readonly string[], reason: EndReason): Promise<string[]> {
    if (handles.length === 0) return [];
    const rows = await db
      .updateTable('sessions')
      .set({ ended_at: this.#now().toISOString(), end_reason: reason })
      .where('handle', 'in', handles)
      .where('ended_at', 'is', null)
      .returning('handle')
      .execute();
    return rows.map((row) => row.handle);
  }

  notifyEnded(handles: readonly string[], reason: EndReason): void {
    for (const handle of handles) {
      this.#grants.delete(handle);
      const streams = this.#streams.get(handle);
      this.#streams.delete(handle);
      if (streams) {
        clearTimeout(streams.timer);
        for (const close of streams.close) this.#call(close);
      }
      for (const hook of this.#ended) this.#call(() => hook(handle, reason));
    }
  }

  #call(fn: () => void): void {
    try {
      fn();
    } catch {
      this.#log.error('session lifecycle hook failed');
    }
  }

  async end(handle: string, reason: EndReason): Promise<boolean> {
    const ended = await writeTx(this.#db, async (db) => {
      if (reason === 'expired') {
        const row = await db.selectFrom('sessions').selectAll().where('handle', '=', handle).executeTakeFirst();
        if (row && row.ended_at === null && this.#now().getTime() < this.deadline(row)) {
          this.#schedule(row);
          return [];
        }
      }
      return this.markEnded(db, [handle], reason);
    });
    this.notifyEnded(ended, reason);
    if (ended.length > 0) this.#logEnded(reason, ended.length);
    return ended.length > 0;
  }

  async endAll(reason: EndReason, except?: string): Promise<void> {
    const handles = await writeTx(this.#db, async (db) => {
      let q = db.selectFrom('sessions').select('handle').where('ended_at', 'is', null);
      if (except !== undefined) q = q.where('handle', '!=', except);
      const rows = await q.execute();
      const handles = rows.map((row) => row.handle);
      await this.markEnded(db, handles, reason);
      return handles;
    });
    this.notifyEnded(handles, reason);
    if (handles.length > 0) this.#logEnded(reason, handles.length);
  }

  // Logging §5: a revoked session is a warning; an ordinary logout or timeout is not.
  #logEnded(reason: EndReason, count: number): void {
    const fields = { reason, count, security: true };
    if (reason === 'logout' || reason === 'expired') this.#log.info('session ended', fields);
    else this.#log.warn('session ended', fields);
  }

  onEnd(fn: (handle: string, reason: EndReason) => void): () => void {
    this.#ended.add(fn);
    return () => {
      this.#ended.delete(fn);
    };
  }
  onStepUpRevoked(fn: (handle: string) => void): () => void {
    this.#alerts.add(fn);
    return () => {
      this.#alerts.delete(fn);
    };
  }

  // Existing streams belong to the stable handle, not the cookie that was current when they opened.
  async streamSession(handle: string): Promise<Session | undefined> {
    if (this.#closed) return undefined;
    const row = await this.#db.selectFrom('sessions').selectAll().where('handle', '=', handle).executeTakeFirst();
    if (!row || row.ended_at !== null || row.recovery_required === 1) return undefined;
    if (this.#now().getTime() >= this.deadline(row)) {
      if (await this.end(handle, 'expired')) return undefined;
      return this.streamSession(handle);
    }
    return {
      idHash: row.id_hash,
      handle: row.handle,
      recoveryRequired: false,
      expiresAt: new Date(this.deadline(row)),
    };
  }

  async registerStream(cookie: string, close: () => void): Promise<() => void> {
    const session = await this.session(cookie);
    if (!session) throw new AppError('unauthenticated', 'Please log in.');
    if (session.recoveryRequired) throw new AppError('permission_denied', 'Recover the authenticator first.');
    const row = await this.live(this.#db, session.idHash);
    let streams = this.#streams.get(row.handle);
    if (streams && streams.close.size >= 3) throw new AppError('busy', 'Too many event streams.', { retryAfter: 1 });
    if (!streams) {
      streams = { close: new Set(), timer: setTimeout(() => {}, 0) };
      this.#streams.set(row.handle, streams);
    }
    let closed = false;
    const terminate = () => {
      if (!closed) {
        closed = true;
        close();
      }
    };
    streams.close.add(terminate);
    this.#schedule(row);
    const unregister = () => {
      const current = this.#streams.get(row.handle);
      if (!current) return;
      current.close.delete(terminate);
      if (current.close.size === 0) {
        clearTimeout(current.timer);
        this.#streams.delete(row.handle);
      }
    };
    // Register before the final validation: a concurrent revocation either finds this callback, or is observed
    // below. Checking only before registration leaves a gap in which logout cannot find the new stream.
    if (!(await this.session(cookie))) {
      unregister();
      this.#call(terminate);
      throw new AppError('unauthenticated', 'Please log in.');
    }
    return unregister;
  }

  #schedule(row: Row): void {
    const streams = this.#streams.get(row.handle);
    if (!streams) return;
    clearTimeout(streams.timer);
    streams.timer = setTimeout(
      () => {
        void this.#expireStream(row.handle).catch(() => this.notifyEnded([row.handle], 'expired'));
      },
      Math.max(1, this.deadline(row) - this.#now().getTime()),
    );
    streams.timer.unref();
  }

  async #expireStream(handle: string): Promise<void> {
    const row = await this.#db.selectFrom('sessions').selectAll().where('handle', '=', handle).executeTakeFirst();
    if (row && row.ended_at === null && this.#now().getTime() < this.deadline(row)) this.#schedule(row);
    else await this.end(handle, 'expired');
  }

  clearGrants(handle: string): void {
    this.#grants.delete(handle);
  }

  #pruneGrants(): void {
    const now = this.#now().getTime();
    for (const [id, g] of this.#grants) if (Math.max(g.password, g.security) <= now) this.#grants.delete(id);
  }

  requireGrant(row: Row, strength: StepUpStrength): void {
    const now = this.#now().getTime();
    this.#pruneGrants();
    if (row.recovery_required === 1 || (this.#grants.get(row.handle)?.[strength] ?? 0) <= now)
      throw new AppError('step_up_required', 'Please re-authenticate for this operation.');
  }

  async authorized<T>(idHash: string, strength: StepUpStrength, fn: (db: Db, row: Row) => Promise<T>): Promise<T> {
    return writeTx(this.#db, async (db) => {
      const row = await this.live(db, idHash);
      this.requireGrant(row, strength);
      return fn(db, row);
    });
  }

  passwordWork<T>(fn: () => Promise<T>): Promise<T> {
    const promise = this.#passwordWork(fn);
    this.#running.add(promise);
    void promise.finally(() => this.#running.delete(promise)).catch(() => {});
    return promise;
  }

  async #passwordWork<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new AppError('busy', 'Server is stopping.', { retryAfter: 1 });
    const ticket = this.#lane.reserve();
    try {
      await ticket.ready;
      if (this.#closed) throw new AppError('busy', 'Server is stopping.', { retryAfter: 1 });
      return await fn();
    } finally {
      ticket.release();
    }
  }

  stepUp(
    idHash: string,
    strength: StepUpStrength,
    requestId: string,
    checkPassword: () => Promise<{ matches: boolean; snapshot: string }>,
    checkFactor: (db: Db, snapshot: string) => Promise<boolean>,
    factorCounter?: FactorCounter,
  ): Promise<NewSession & { strength: StepUpStrength; stepUpExpiresAt: Date }> {
    const promise = this.#stepUp(idHash, strength, requestId, checkPassword, checkFactor, factorCounter);
    this.#running.add(promise);
    void promise.finally(() => this.#running.delete(promise)).catch(() => {});
    return promise;
  }

  async #stepUp(
    idHash: string,
    strength: StepUpStrength,
    requestId: string,
    checkPassword: () => Promise<{ matches: boolean; snapshot: string }>,
    checkFactor: (db: Db, snapshot: string) => Promise<boolean>,
    factorCounter?: FactorCounter,
  ) {
    if (this.#closed) throw new AppError('busy', 'Server is stopping.', { retryAfter: 1 });
    if (this.#claims.has(idHash))
      throw new AppError('too_early', 'A step-up is already in progress.', { retryAfter: 1 });
    const ticket = this.#lane.reserve();
    this.#claims.add(idHash);
    try {
      const row = await this.live(this.#db, idHash);
      if (row.recovery_required === 1) throw new AppError('permission_denied', 'Recover the authenticator first.');
      const wait = row.step_up_retry_at - this.#now().getTime();
      if (wait > 0)
        throw new AppError('too_early', 'Wait before trying again.', { retryAfter: Math.ceil(wait / 1000) });
      await ticket.ready;
      await this.live(this.#db, idHash);
      const password = await checkPassword();
      const result = await writeTx(this.#db, async (db) => {
        const current = await this.live(db, idHash);
        if (current.recovery_required === 1)
          throw new AppError('permission_denied', 'Recover the authenticator first.');
        if (!password.matches || !(await checkFactor(db, password.snapshot))) {
          const failures = current.step_up_failures + 1;
          // The password matched, so the second factor was wrong (or the password changed meanwhile, which is
          // counted the same way: the conservative side).
          const factorFailed = strength === 'security' && password.matches;
          await db
            .updateTable('sessions')
            .set({
              step_up_failures: failures,
              step_up_retry_at: this.#now().getTime() + Math.min(2 ** (failures - 1), 900) * 1000,
              ...(factorFailed ? { step_up_factor_failed: 1 } : {}),
            })
            .where('id_hash', '=', idHash)
            .execute();
          if (factorFailed) await factorCounter?.failed(db);
          if (failures >= 5) await this.markEnded(db, [current.handle], 'step_up_failures');
          return { ok: false as const, revoked: failures >= 5, handle: current.handle, factorFailed };
        }
        const cookieValue = randomBytes(32).toString('base64url');
        // Only a password + TOTP success clears TOTP failures. Otherwise someone who knows the password could
        // reset the count with a password-only step-up after every few TOTP guesses and never reach revocation.
        const keepFailures = strength === 'password' && current.step_up_factor_failed === 1;
        await db
          .updateTable('sessions')
          .set({
            id_hash: sessionDigest(cookieValue),
            ...(keepFailures ? {} : { step_up_failures: 0, step_up_retry_at: 0, step_up_factor_failed: 0 }),
          })
          .where('id_hash', '=', idHash)
          .execute();
        if (strength === 'security') await factorCounter?.succeeded(db);
        return { ok: true as const, cookieValue, row: current };
      });
      if (!result.ok) {
        this.#log.warn('step-up failed', {
          requestId,
          security: true,
          revoked: result.revoked,
          ...(result.factorFailed ? { factor: 'totp' } : {}),
        });
        if (result.revoked) {
          this.notifyEnded([result.handle], 'step_up_failures');
          for (const alert of this.#alerts) this.#call(() => alert(result.handle));
        }
        throw new AppError('login_failed', 'Re-authentication failed.');
      }
      this.#pruneGrants();
      const until = this.#now().getTime() + GRANT_MS;
      const existing = this.#grants.get(result.row.handle);
      this.#grants.set(result.row.handle, {
        password: until,
        security: strength === 'security' ? until : (existing?.security ?? 0),
      });
      this.#log.info('step-up succeeded', { requestId, security: true, strength });
      return {
        cookieValue: result.cookieValue,
        csrfToken: csrfTokenFor(result.cookieValue),
        expiresAt: new Date(result.row.expires_at),
        recoveryRequired: false,
        strength,
        stepUpExpiresAt: new Date(until),
      };
    } finally {
      ticket.release();
      this.#claims.delete(idHash);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#lane.close();
    await Promise.allSettled([...this.#running]);
    for (const streams of this.#streams.values()) {
      clearTimeout(streams.timer);
      for (const close of streams.close) this.#call(close);
    }
    this.#streams.clear();
    this.#grants.clear();
    this.#ended.clear();
    this.#alerts.clear();
  }
}
