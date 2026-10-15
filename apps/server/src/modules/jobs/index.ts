import { sql } from 'kysely';
import { writeTx, type Db } from '../../storage/db.ts';
import type { AuthService } from '../auth/index.ts';
import type { Logger } from '../../logging/logger.ts';

const DAY = 86400000;
export class Housekeeping {
  readonly #db: Db;
  readonly #auth: AuthService;
  readonly #log: Logger;
  readonly #now: () => Date;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;
  #started = false;
  constructor(options: { db: Db; auth: AuthService; logger: Logger; now?: () => Date }) {
    this.#db = options.db;
    this.#auth = options.auth;
    this.#log = options.logger.child('jobs');
    this.#now = options.now ?? (() => new Date());
  }
  run(): Promise<void> {
    if (this.#running) return this.#running;
    if (this.#stopped) return Promise.resolve();
    this.#running = this.#pass().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }
  async #pass(): Promise<void> {
    const now = this.#now().getTime();
    const at = (age = 0) => new Date(now - age).toISOString();
    const ended: string[] = [];
    const counts: { table: string; deleted: number }[] = [];
    const count = (table: string, deleted: number | bigint) => counts.push({ table, deleted: Number(deleted) });
    await writeTx(this.#db, async (db) => {
      // Effective deadlines include the current owner policy, even for sessions never read again.
      for (const row of await db.selectFrom('sessions').selectAll().where('ended_at', 'is', null).execute()) {
        const deadline = this.#auth.sessions.deadline(row);
        if (deadline <= now) {
          await db
            .updateTable('sessions')
            .set({ ended_at: new Date(deadline).toISOString(), end_reason: 'expired' })
            .where('handle', '=', row.handle)
            .execute();
          ended.push(row.handle);
        }
      }
      count(
        'sessions',
        (
          await db
            .deleteFrom('sessions')
            .where('ended_at', '<=', at(30 * DAY))
            .executeTakeFirstOrThrow()
        ).numDeletedRows,
      );
      count(
        'known_devices',
        (
          await db
            .deleteFrom('known_devices')
            .where((eb) => eb.or([eb('expires_at', '<=', at()), eb('last_seen_at', '<=', at(365 * DAY))]))
            .executeTakeFirstOrThrow()
        ).numDeletedRows,
      );
      count(
        'setup_token',
        (await db.deleteFrom('setup_token').where('expires_at', '<=', at()).executeTakeFirstOrThrow()).numDeletedRows,
      );
      count('login_throttles', await this.#auth.pruneThrottles(db));
      count(
        'recovery_codes',
        (await db.deleteFrom('recovery_codes').where('used_at', 'is not', null).executeTakeFirstOrThrow())
          .numDeletedRows,
      );
      await db
        .updateTable('spend_intents')
        .set({ psbt_key_id: null, psbt_nonce: null, psbt_ciphertext: null })
        .where('state', 'in', ['succeeded', 'failed'])
        .execute();
      count(
        'spend_intents',
        (
          await db
            .deleteFrom('spend_intents')
            .where('state', 'in', ['succeeded', 'failed'])
            .where('updated_at', '<=', at(30 * DAY))
            .executeTakeFirstOrThrow()
        ).numDeletedRows,
      );
      count(
        'restore_counts',
        (await db.deleteFrom('restore_counts').where('until', '<=', at()).executeTakeFirstOrThrow()).numDeletedRows,
      );
      count(
        'restores',
        (
          await db
            .deleteFrom('restores')
            .where('recorded_at', '<=', at(365 * DAY))
            .where('id', 'not in', db.selectFrom('restore_counts').select('restore_id'))
            .executeTakeFirstOrThrow()
        ).numDeletedRows,
      );
    });
    this.#auth.sessions.notifyEnded(ended, 'expired');
    await sql`PRAGMA optimize`.execute(this.#db);
    this.#log.pruneFiles();
    this.#log.info('housekeeping complete', { counts, expiredSessions: ended.length });
  }
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    const schedule = () => {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.run()
          .catch(() => this.#log.warn('housekeeping failed'))
          .finally(() => {
            if (!this.#stopped) schedule();
          });
      }, DAY);
      this.#timer.unref();
    };
    schedule();
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }
}
