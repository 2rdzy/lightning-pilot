import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir, testDb } from '../../testing.ts';
import { createLogger } from '../../logging/logger.ts';
import { AuthService } from '../auth/index.ts';
import { Vault } from '../vault/index.ts';
import { Housekeeping } from './index.ts';

const DAY = 86400000;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function harness() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const { db, raw } = await testDb(t.dir);
  cleanups.push(() => db.destroy());
  const vault = await Vault.start(db, randomBytes(32));
  await vault.initialise(db);
  cleanups.push(() => vault.close());
  const now = new Date('2026-10-15T12:00:00Z');
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line) });
  const auth = await AuthService.create({
    db,
    raw,
    vault,
    logger,
    setupUrl: 'https://localhost/setup',
    now: () => now,
  });
  cleanups.push(() => auth.close());
  const jobs = new Housekeeping({ db, auth, logger, now: () => now });
  cleanups.push(() => jobs.stop());
  const at = (age = 0) => new Date(now.getTime() - age).toISOString();
  return { db, raw, vault, auth, jobs, lines, at, now };
}

describe('retention housekeeping', () => {
  it('enforces session/device/token/throttle boundaries and preserves live policy', async () => {
    const h = await harness();
    const { db, at } = h;
    for (const [id, age] of [
      ['keep', 30 * DAY - 1],
      ['edge', 30 * DAY],
      ['old', 31 * DAY],
    ] as const) {
      await db
        .insertInto('sessions')
        .values({
          id_hash: id,
          handle: id,
          created_at: at(60 * DAY),
          last_seen_at: at(age),
          expires_at: at(age),
          ended_at: at(age),
        })
        .execute();
    }
    for (const [id, age] of [
      ['keep', 365 * DAY - 1],
      ['edge', 365 * DAY],
      ['old', 366 * DAY],
    ] as const) {
      await db
        .insertInto('known_devices')
        .values({ id_hash: id, created_at: at(400 * DAY), last_seen_at: at(age), expires_at: at(-DAY) })
        .execute();
    }
    await db
      .insertInto('known_devices')
      .values({ id_hash: 'expiry', created_at: at(DAY), last_seen_at: at(), expires_at: at() })
      .execute();
    await db
      .insertInto('recovery_codes')
      .values([
        { code_hash: 'unused', used_at: null },
        { code_hash: 'used', used_at: at() },
      ])
      .execute();
    await db.insertInto('setup_token').values({ id: 1, token_hash: 'private-token', expires_at: at() }).execute();
    for (const [counter, kind, age, next] of [
      ['old-ip', 'ip', DAY, -1000],
      ['keep-ip', 'ip', DAY - 1, -1000],
      ['setup', 'setup', DAY + 1, -1000],
      ['factor', 'factor', DAY, -1000],
      ['device', 'device', DAY, -1000],
      ['global', 'global', 1, 0],
    ] as const)
      await db
        .insertInto('login_throttles')
        .values({
          counter,
          kind,
          failures: 2,
          next_allowed_at: h.now.getTime() + next,
          last_failed_at: h.now.getTime() - age,
        })
        .execute();
    const policy = '{"idleSeconds":900,"absoluteSeconds":3600}';
    await db.insertInto('settings').values({ key: 'session_policy', value: policy }).execute();
    await h.jobs.run();
    expect(await db.selectFrom('sessions').select('handle').execute()).toEqual([{ handle: 'keep' }]);
    expect(await db.selectFrom('known_devices').select('id_hash').execute()).toEqual([{ id_hash: 'keep' }]);
    expect(await db.selectFrom('recovery_codes').selectAll().execute()).toEqual([
      { code_hash: 'unused', used_at: null },
    ]);
    expect(await db.selectFrom('setup_token').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('login_throttles').select('counter').execute()).toEqual([{ counter: 'keep-ip' }]);
    expect(
      (await db.selectFrom('settings').select('value').where('key', '=', 'session_policy').executeTakeFirstOrThrow())
        .value,
    ).toBe(policy);
    expect(h.lines.join('\n')).not.toContain('private-token');
    const report = JSON.parse(h.lines.find((line) => line.includes('housekeeping complete')) ?? '{}');
    expect(report.counts).toContainEqual({ table: 'setup_token', deleted: 1 });
    await db
      .insertInto('setup_token')
      .values({ id: 1, token_hash: 'keep', expires_at: at(-1) })
      .execute();
    await db
      .insertInto('login_throttles')
      .values({
        counter: 'global',
        kind: 'global',
        failures: 30,
        next_allowed_at: h.now.getTime() + 1,
        last_failed_at: h.now.getTime(),
      })
      .execute();
    await h.jobs.run();
    expect(await db.selectFrom('setup_token').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('login_throttles').selectAll().execute()).toHaveLength(2);
  });

  it('uses current session deadlines and notifies listeners only after commit', async () => {
    const h = await harness();
    await h.db
      .insertInto('settings')
      .values({ key: 'session_policy', value: '{"idleSeconds":900,"absoluteSeconds":3600}' })
      .execute();
    await h.auth.sessions.loadPolicy();
    for (const [id, created, last] of [
      ['live', 1000, 1000],
      ['idle', 1000000, 900000],
      ['absolute', 3600000, 1000],
      ['ancient', 40 * DAY, 40 * DAY],
    ] as const)
      await h.db
        .insertInto('sessions')
        .values({
          id_hash: id,
          handle: id,
          created_at: h.at(created),
          last_seen_at: h.at(last),
          expires_at: h.at(-DAY),
        })
        .execute();
    const ended: string[] = [];
    h.auth.sessions.onEnd((handle) => ended.push(handle));
    await h.jobs.run();
    expect(ended.sort()).toEqual(['absolute', 'ancient', 'idle']);
    const rows = await h.db.selectFrom('sessions').selectAll().execute();
    expect(rows.find((r) => r.handle === 'live')?.ended_at).toBeNull();
    expect(rows.find((r) => r.handle === 'idle')?.ended_at).toBe(h.at());
    expect(rows.some((r) => r.handle === 'ancient')).toBe(false);
  });

  it('preserves unresolved intents, replay identity and active restore budget windows', async () => {
    const h = await harness();
    const { db, at } = h;
    await db
      .insertInto('nodes')
      .values({
        id: 'node',
        name: 'test',
        chain: 'bitcoin',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://localhost',
        ca_certificate: '',
        server_name: 'localhost',
        pubkey: '02' + '11'.repeat(32),
        identity_state: 'confirmed',
        identity_failed_check: null,
        identity_detail: null,
        identity_checked_at: at(),
        created_at: at(500 * DAY),
      })
      .execute();
    for (const [id, state, age] of [
      ['reserved', 'reserved', 500 * DAY],
      ['sent', 'sent', 500 * DAY],
      ['unknown', 'unknown', 500 * DAY],
      ['failed', 'failed', 30 * DAY],
      ['succeeded', 'succeeded', 31 * DAY],
      ['keep', 'succeeded', 30 * DAY - 1],
    ] as const) {
      const sealed = h.vault.sealSecret('private-psbt', `intent_psbt:${id}`);
      await db
        .insertInto('spend_intents')
        .values({
          id,
          node_id: 'node',
          chain: 'bitcoin',
          pubkey: '02' + '11'.repeat(32),
          type: 'onchain',
          payment_hash: null,
          amount_msat: '1000',
          max_fee_msat: '1000',
          fee_msat: null,
          state,
          idempotency_key: id,
          session_handle: 'original-session',
          confirmation_hash: 'replay-token-hash',
          digest: 'digest',
          error_code: null,
          created_at: at(age),
          updated_at: at(age),
          psbt_key_id: sealed.key_id,
          psbt_nonce: sealed.nonce,
          psbt_ciphertext: sealed.ciphertext,
        })
        .execute();
    }
    for (const [id, age, until] of [
      ['old', 365 * DAY, 0],
      ['keep', 365 * DAY - 1, 0],
      ['active', 366 * DAY, -1],
    ] as const) {
      await db
        .insertInto('restores')
        .values({ id, marker_hash: id, restored_at: at(age), backup_file: 'backup', recorded_at: at(age) })
        .execute();
      await db
        .insertInto('restore_counts')
        .values({
          restore_id: id,
          chain: 'bitcoin',
          pubkey: '02' + '11'.repeat(32),
          state: 'pending',
          counted_msat: null,
          counted_at: null,
          until: at(until),
        })
        .execute();
    }
    await h.jobs.run();
    const rows = await db.selectFrom('spend_intents').selectAll().orderBy('id').execute();
    expect(rows.map((r) => r.id)).toEqual(['keep', 'reserved', 'sent', 'unknown']);
    expect(rows.find((r) => r.id === 'keep')?.psbt_ciphertext).toBeNull();
    for (const row of rows.filter((r) => r.id !== 'keep')) {
      expect(row.psbt_ciphertext).not.toBeNull();
      expect(row.confirmation_hash).toBe('replay-token-hash');
    }
    expect(await db.selectFrom('restore_counts').select('restore_id').execute()).toEqual([{ restore_id: 'active' }]);
    expect((await db.selectFrom('restores').select('id').orderBy('id').execute()).map((r) => r.id)).toEqual([
      'active',
      'keep',
    ]);
    expect(await db.selectFrom('nodes').selectAll().execute()).toHaveLength(1);
    expect(h.lines.join('\n')).not.toContain('private-psbt');
  });

  it('coalesces passes and drains in-flight work before shutdown', async () => {
    const h = await harness();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = h.auth.pruneThrottles.bind(h.auth);
    vi.spyOn(h.auth, 'pruneThrottles').mockImplementation(async (db) => {
      started();
      await gate;
      return original(db);
    });
    const first = h.jobs.run();
    expect(h.jobs.run()).toBe(first);
    await admitted;
    let stopped = false;
    const stop = h.jobs.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    await first;
    const calls = h.lines.length;
    await h.jobs.run();
    expect(h.lines).toHaveLength(calls);
  });

  it('schedules once daily, retries errors and never starts again after stopping', async () => {
    const h = await harness();
    vi.useFakeTimers();
    const run = vi
      .spyOn(h.jobs, 'run')
      .mockRejectedValueOnce(new Error('private-database-error'))
      .mockResolvedValue(undefined);
    h.jobs.start();
    h.jobs.start();
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.lines.join('\n')).toContain('housekeeping failed');
    expect(h.lines.join('\n')).not.toContain('private-database-error');
    await vi.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(2);
    await h.jobs.stop();
    h.jobs.start();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
