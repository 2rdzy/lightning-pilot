import { mkdirSync, readdirSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
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

  it('rebuilds the throttle and limit tables without losing rows, then enforces the limit checks', async () => {
    const dir = copyMigrations();
    const later = readdirSync(dir).filter((f) => f >= '20261014T1200');
    expect(later).toEqual([
      '20261014T1200_auth_setup_factor_counters.sql',
      '20261014T1201_spend_limits_checks.sql',
      '20261014T1500_spend_admission.sql',
      '20261014T1900_spend_intent_preimage.sql',
      '20261014T2000_sessions_step_up_factor.sql',
    ]);
    const held = join(dir, '..', 'held');
    mkdirSync(held);
    for (const f of later) {
      copyFileSync(join(dir, f), join(held, f));
      unlinkSync(join(dir, f));
    }
    const raw = await freshRaw();
    migrate(raw, dir);
    raw.exec(`INSERT INTO login_throttles VALUES ('ip:a', 'ip', 3, 10, 5), ('global', 'global', 31, 70, 6)`);
    raw.exec(`INSERT INTO spend_limits VALUES ('blake2b', '02aa', '100', NULL, '50', '12.5', 5, 1, '10')`);
    for (const f of later) copyFileSync(join(held, f), join(dir, f));
    expect(migrate(raw, dir)).toEqual(later);
    const db = kyselyOf(raw);
    expect(await db.selectFrom('login_throttles').selectAll().orderBy('counter').execute()).toEqual([
      { counter: 'global', kind: 'global', failures: 31, next_allowed_at: 70, last_failed_at: 6 },
      { counter: 'ip:a', kind: 'ip', failures: 3, next_allowed_at: 10, last_failed_at: 5 },
    ]);
    expect(await db.selectFrom('spend_limits').select(['max_fee_rate', 'step_up_above_sat']).execute()).toEqual([
      { max_fee_rate: '12.5', step_up_above_sat: '50' },
    ]);
    const row = (change: Record<string, unknown>) => ({
      chain: 'sha256d',
      pubkey: `02${Object.keys(change).join('')}${JSON.stringify(Object.values(change))}`,
      max_per_payment_sat: null,
      max_24h_sat: null,
      step_up_above_sat: null,
      max_fee_rate: '3',
      max_fee_share_percent: 5,
      max_routing_fee_share_percent: 1,
      routing_fee_allowance_sat: '10',
      ...change,
    });
    for (const rate of ['0.001', '1', '9999999.999', '30.25'])
      await db
        .insertInto('spend_limits')
        .values(row({ max_fee_rate: rate }))
        .execute();
    await db
      .insertInto('spend_limits')
      .values(row({ max_fee_share_percent: 100, max_routing_fee_share_percent: 0 }))
      .execute();
    for (const bad of [
      { max_fee_rate: '0' },
      { max_fee_rate: '0.000' },
      { max_fee_rate: 'fast' },
      { max_fee_rate: '01' },
      { max_fee_rate: '1.' },
      { max_fee_rate: '.5' },
      { max_fee_rate: '1.2345' },
      { max_fee_rate: '1.2.3' },
      { max_fee_rate: '10000000' },
      { max_fee_rate: '-1' },
      { max_fee_share_percent: 0 },
      { max_fee_share_percent: 101 },
      { max_routing_fee_share_percent: -1 },
      { max_routing_fee_share_percent: 101 },
    ])
      await expect(db.insertInto('spend_limits').values(row(bad)).execute(), JSON.stringify(bad)).rejects.toThrow(
        /CHECK/,
      );
    await expect(
      db
        .insertInto('login_throttles')
        .values({ counter: 'x', kind: 'factor', failures: 1, next_allowed_at: 0, last_failed_at: 0 })
        .execute(),
    ).rejects.toThrow(/CHECK/);
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
    for (const bad of ['', '-1', '01', '1.5', '1e3', 'abc', '1'.repeat(22)])
      await expect(
        db
          .insertInto('spend_intents')
          .values({ ...intent(`cost-${bad}`, '1000'), cost_msat: bad })
          .execute(),
      ).rejects.toThrow(/CHECK/);
    await db
      .insertInto('spend_intents')
      .values({ ...intent('cost-zero', '1000'), cost_msat: '0' })
      .execute();

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
