import { mkdirSync, readdirSync, statSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
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

  // update-rollback §3 and §6: a backup before the first migration of an update, only the latest kept, named by a
  // failed migration and by the refusal of a database from a newer version.
  describe('pre-update backup', () => {
    const backups = () => {
      const { dir, cleanup } = tempDir();
      cleanups.push(cleanup);
      return join(dir, 'backups');
    };
    const tables = (raw: Awaited<ReturnType<typeof openRaw>>) =>
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all([]) as { name: string }[]
      ).map((r) => r.name);

    it('writes no backup for a fresh database', async () => {
      const target = backups();
      migrate(await freshRaw(), MIGRATIONS_DIR, { dir: target });
      expect(() => readdirSync(target)).toThrow();
    });

    it('writes a backup before the first migration of an update, keeps only the latest, mode 0600', async () => {
      const dir = copyMigrations();
      const target = backups();
      const raw = await freshRaw();
      migrate(raw, dir, { dir: target });
      writeFileSync(join(dir, '29990101T0000_test_first.sql'), 'CREATE TABLE first_update (a TEXT) STRICT;');
      expect(migrate(raw, dir, { dir: target, now: () => new Date('2026-10-15T10:00:00.123Z') })).toEqual([
        '29990101T0000_test_first.sql',
      ]);
      const [first] = readdirSync(target);
      expect(first).toMatch(/^pre-\d{8}T\d{4}-to-29990101T0000-20261015T100000Z\.sqlite$/);
      expect(statSync(join(target, first ?? '')).mode & 0o777).toBe(0o600);
      // The backup holds the database as it was before the update.
      const saved = await openRaw(join(target, first ?? ''), testDriver());
      expect(tables(saved)).not.toContain('first_update');
      expect(tables(saved)).toContain('spend_intents');
      saved.close();
      writeFileSync(join(dir, '29990102T0000_test_second.sql'), 'CREATE TABLE second_update (a TEXT) STRICT;');
      migrate(raw, dir, { dir: target, now: () => new Date('2026-10-16T10:00:00Z') });
      expect(readdirSync(target)).toEqual(['pre-29990101T0000-to-29990102T0000-20261016T100000Z.sqlite']);
      // Nothing pending: no new backup.
      migrate(raw, dir, { dir: target, now: () => new Date('2026-10-17T10:00:00Z') });
      expect(readdirSync(target)).toHaveLength(1);
    });

    it('names the migration and the backup when a migration fails', async () => {
      const dir = copyMigrations();
      const target = backups();
      const raw = await freshRaw();
      migrate(raw, dir, { dir: target });
      writeFileSync(join(dir, '29991231T2359_test_broken.sql'), 'NOT SQL;');
      expect(() => migrate(raw, dir, { dir: target })).toThrow(
        /migration 29991231T2359_test_broken\.sql failed and was rolled back: .*the database before this update is in .*backups\/pre-.*\.sqlite/,
      );
    });

    it('keeps the first backup when a failed update is retried, and prunes older ones only once it applies', async () => {
      const dir = copyMigrations();
      const target = backups();
      const raw = await freshRaw();
      migrate(raw, dir, { dir: target });
      writeFileSync(join(dir, '29990101T0000_test_old.sql'), 'SELECT 1;');
      migrate(raw, dir, { dir: target, now: () => new Date('2026-10-14T10:00:00Z') });
      const older = readdirSync(target);
      expect(older).toHaveLength(1);
      // An update with two migrations, the second failing; the service restarts and retries.
      writeFileSync(join(dir, '29990201T0000_test_m1.sql'), 'CREATE TABLE m1 (a TEXT) STRICT;');
      writeFileSync(join(dir, '29990202T0000_test_m2.sql'), 'NOT SQL;');
      for (const at of ['2026-10-15T10:00:00Z', '2026-10-15T10:01:00Z'])
        expect(() => migrate(raw, dir, { dir: target, now: () => new Date(at) })).toThrow(
          /pre-29990101T0000-to-29990202T0000-20261015T100000Z\.sqlite/,
        );
      const kept = readdirSync(target).filter((f) => !older.includes(f));
      expect(kept).toEqual(['pre-29990101T0000-to-29990202T0000-20261015T100000Z.sqlite']);
      // The previous update's backup stays until this one applies; the new one does not hold the migration that did.
      expect(readdirSync(target)).toHaveLength(2);
      const saved = await openRaw(join(target, kept[0] ?? ''), testDriver());
      expect(tables(saved)).not.toContain('m1');
      saved.close();
      writeFileSync(join(dir, '29990202T0000_test_m2.sql'), 'CREATE TABLE m2 (a TEXT) STRICT;');
      expect(migrate(raw, dir, { dir: target })).toEqual(['29990202T0000_test_m2.sql']);
      expect(readdirSync(target)).toEqual(kept);
    });

    it('refuses a database migrated by a newer version, naming the backup to restore', async () => {
      const dir = copyMigrations();
      const target = backups();
      const raw = await freshRaw();
      migrate(raw, dir, { dir: target });
      writeFileSync(join(dir, '29990101T0000_test_newer.sql'), 'SELECT 1;');
      migrate(raw, dir, { dir: target });
      unlinkSync(join(dir, '29990101T0000_test_newer.sql'));
      expect(() => migrate(raw, dir, { dir: target })).toThrow(
        /database was upgraded by a newer Lightning Pilot .*29990101T0000_test_newer\.sql.*install that version or newer, or restore .*pre-.*\.sqlite/,
      );
      expect(() => migrate(raw, dir)).toThrow(/install that version or newer$/);
    });
  });

  it('rebuilds the intent table for new spend types without losing a row or an index', async () => {
    const dir = copyMigrations();
    const held = join(dir, '..', 'held-intents');
    mkdirSync(held);
    const name = '20261014T2100_spend_intent_types.sql';
    copyFileSync(join(dir, name), join(held, name));
    unlinkSync(join(dir, name));
    const raw = await freshRaw();
    migrate(raw, dir);
    raw.exec(`INSERT INTO nodes VALUES ('n1', 'node', 'blake2b', 'regtest', 'cln', 'https://n', 'ca', 'n', '02aa',
      'confirmed', NULL, NULL, 't', 't')`);
    const columns = `id, node_id, chain, pubkey, type, payment_hash, amount_msat, max_fee_msat, fee_msat, state,
      idempotency_key, digest, error_code, created_at, updated_at, cost_msat, destination, session_handle,
      confirmation_hash, preimage`;
    raw.exec(`INSERT INTO spend_intents (${columns}) VALUES ('i1', 'n1', 'blake2b', '02aa', 'bolt11', '${'ab'.repeat(32)}',
      '1000', '10', '2', 'succeeded', 'key-1', 'd', NULL, 't1', 't2', '1010', '03bb', 'h', 'c', '${'cd'.repeat(32)}'),
      ('i2', 'n1', 'blake2b', '02aa', 'bolt11', '${'ef'.repeat(32)}', '5', '0', NULL, 'unknown', 'key-2', 'd', 'x',
      't3', 't4', NULL, NULL, NULL, NULL, NULL)`);
    const before = raw.prepare(`SELECT ${columns} FROM spend_intents ORDER BY id`).all([]);
    copyFileSync(join(held, name), join(dir, name));
    expect(migrate(raw, dir)).toEqual([name]);
    expect(raw.prepare(`SELECT ${columns} FROM spend_intents ORDER BY id`).all([])).toEqual(before);
    expect(
      raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'spend_intents' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all([]),
    ).toEqual(
      ['spend_intents_hash_identity', 'spend_intents_identity', 'spend_intents_node', 'spend_intents_txid'].map(
        (n) => ({ name: n }),
      ),
    );
    const insert = (id: string, type: string, hash: string | null, extra = '') =>
      raw.exec(`INSERT INTO spend_intents (id, node_id, chain, pubkey, type, payment_hash, amount_msat, max_fee_msat,
        state, idempotency_key, digest, created_at, updated_at${extra ? ', txid' : ''}) VALUES ('${id}', 'n1',
        'blake2b', '02aa', '${type}', ${hash === null ? 'NULL' : `'${hash}'`}, '1000', '0', 'reserved', 'k-${id}', 'd',
        't', 't'${extra ? `, '${extra}'` : ''})`);
    insert('o1', 'onchain', null, '12'.repeat(32));
    insert('c1', 'channel-open', null);
    insert('c2', 'channel-close', null);
    expect(() => insert('o2', 'onchain', 'ab'.repeat(32))).toThrow();
    expect(() => insert('b1', 'bolt11', null)).toThrow();
    expect(() => insert('k1', 'keysend', null)).toThrow();
    expect(() => insert('o3', 'onchain', null, 'not-a-txid')).toThrow();
    expect(() => insert('i1', 'onchain', null)).toThrow();
    // The idempotency key stays unique.
    expect(() => raw.exec(`UPDATE spend_intents SET idempotency_key = 'key-1' WHERE id = 'o1'`)).toThrow();
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
      '20261014T2100_spend_intent_types.sql',
      '20261015T1000_spend_restores.sql',
      '20261015T1200_events_cursors.sql',
      '20261015T1400_jobs_confirmations.sql',
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
