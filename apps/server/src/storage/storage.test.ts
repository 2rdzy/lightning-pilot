import { mkdirSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, testDriver } from '../testing.ts';
import { kyselyOf, openRaw, writeTx } from './db.ts';
import { migrate, MIGRATIONS_DIR, MigrationError } from './migrate.ts';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function copyMigrations(): string {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const target = join(dir, 'migrations');
  mkdirSync(target);
  for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, f), join(target, f));
  return target;
}

async function freshRaw() {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  return openRaw(join(dir, 'db.sqlite'), testDriver());
}

describe(`storage (${testDriver()})`, () => {
  it('applies every migration once, in name order', async () => {
    const raw = await freshRaw();
    const first = migrate(raw);
    expect(first).toEqual([...first].sort());
    expect(first.length).toBeGreaterThan(0);
    expect(migrate(raw)).toEqual([]);
  });

  it('stops when an applied migration was modified or deleted', async () => {
    const dir = copyMigrations();
    const raw = await freshRaw();
    migrate(raw, dir);
    const [name] = readdirSync(dir).sort();
    if (!name) throw new Error('no migrations');
    writeFileSync(join(dir, name), '-- changed\n', { flag: 'a' });
    expect(() => migrate(raw, dir)).toThrow(MigrationError);
  });

  it('refuses a migration file with an unexpected name', async () => {
    const dir = copyMigrations();
    writeFileSync(join(dir, '0001_init.sql'), 'SELECT 1;');
    const raw = await freshRaw();
    expect(() => migrate(raw, dir)).toThrow(/not recognised/);
  });

  it('rolls back a failing migration as a whole', async () => {
    const dir = copyMigrations();
    writeFileSync(join(dir, '29991231T2359_test_broken.sql'), 'CREATE TABLE half (a TEXT) STRICT;\nNOT SQL;');
    const raw = await freshRaw();
    expect(() => migrate(raw, dir)).toThrow();
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").all([]);
    expect(tables).toEqual([]);
  });

  it('refuses amounts that are not canonical decimal msat', async () => {
    const raw = await freshRaw();
    migrate(raw);
    const db = kyselyOf(raw);
    const now = new Date().toISOString();
    await db
      .insertInto('nodes')
      .values({
        id: 'n1',
        name: 'n',
        chain: 'blake2b',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://x',
        ca_certificate: '',
        server_name: 'localhost',
        pubkey: '02' + '0'.repeat(64),
        identity_state: 'confirmed',
        identity_failed_check: null,
        identity_detail: null,
        identity_checked_at: now,
        created_at: now,
      })
      .execute();
    const intent = (id: string, amount: string) => ({
      id,
      node_id: 'n1',
      chain: 'blake2b',
      pubkey: 'p',
      type: 'bolt11',
      payment_hash: 'h',
      amount_msat: amount,
      max_fee_msat: '0',
      fee_msat: null,
      state: 'reserved',
      idempotency_key: id,
      digest: 'd',
      error_code: null,
      created_at: now,
      updated_at: now,
    });
    await db.insertInto('spend_intents').values(intent('ok', '1000')).execute();
    for (const bad of ['-1', '01', '1.5', '1e3', 'abc']) {
      await expect(
        db
          .insertInto('spend_intents')
          .values(intent(`bad${bad}`, bad))
          .execute(),
        bad,
      ).rejects.toThrow();
    }
  });

  it('rolls back a write transaction on error', async () => {
    const raw = await freshRaw();
    migrate(raw);
    const db = kyselyOf(raw);
    await expect(
      writeTx(db, async (trx) => {
        await trx.insertInto('settings').values({ key: 'k', value: 'v' }).execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.selectFrom('settings').selectAll().execute()).toEqual([]);
  });
});
