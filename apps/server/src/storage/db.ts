// Storage: SQLite through Node's built-in node:sqlite, with Kysely as the query builder. One connection per process;
// write transactions take the write lock up front (BEGIN IMMEDIATE). better-sqlite3 is the tested fallback driver:
// the test job runs the server's tests on it too, so the driver can be switched if node:sqlite changes.
import { DatabaseSync } from 'node:sqlite';
import { Kysely, sql, SqliteDialect, type SqliteDatabase, type SqliteStatement } from 'kysely';
import type { DB } from './schema.ts';

export type RawDb = SqliteDatabase & { exec(sql: string): void };
export type Driver = 'node:sqlite' | 'better-sqlite3';
export type Db = Kysely<DB>;

// synchronous=FULL: a committed spend intent must survive power loss.
const PRAGMAS = ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000', 'synchronous = FULL'];

// Kysely's SqliteDialect expects a better-sqlite3-like API; this maps node:sqlite onto it.
function wrapNodeSqlite(db: DatabaseSync): RawDb {
  return {
    close: () => db.close(),
    exec: (text: string) => db.exec(text),
    prepare: (text: string): SqliteStatement => {
      const stmt = db.prepare(text);
      // node:sqlite's bind types are narrower than Kysely's unknown[]; Kysely passes only the SQLite types.
      const args = (params: ReadonlyArray<unknown>) => params as never[];
      return {
        get reader() {
          return stmt.columns().length > 0;
        },
        all: (params) => stmt.all(...args(params)),
        run: (params) => {
          const r = stmt.run(...args(params));
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
        iterate: (params) => stmt.iterate(...args(params)),
      };
    },
  };
}

export async function openRaw(file: string, driver: Driver = 'node:sqlite'): Promise<RawDb> {
  if (driver === 'better-sqlite3') {
    const { default: Better } = await import('better-sqlite3');
    const raw = new Better(file);
    for (const p of PRAGMAS) raw.pragma(p);
    return raw as unknown as RawDb;
  }
  const raw = new DatabaseSync(file);
  for (const p of PRAGMAS) raw.exec(`PRAGMA ${p}`);
  return wrapNodeSqlite(raw);
}

export function kyselyOf(raw: RawDb): Db {
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
}

// Runs fn inside BEGIN IMMEDIATE … COMMIT, rolling back on any error. A deferred BEGIN that reads first and writes
// later can fail with "database is locked" when another writer gets in between.
export async function writeTx<T>(db: Db, fn: (trx: Db) => Promise<T>): Promise<T> {
  return db.connection().execute(async (conn) => {
    await sql`BEGIN IMMEDIATE`.execute(conn);
    try {
      const result = await fn(conn);
      await sql`COMMIT`.execute(conn);
      return result;
    } catch (err) {
      await sql`ROLLBACK`.execute(conn);
      throw err;
    }
  });
}
