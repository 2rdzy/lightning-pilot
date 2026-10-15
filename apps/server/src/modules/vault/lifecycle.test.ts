import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, testDb, writeVaultKey, setupForTest, testDriver } from '../../testing.ts';
import { kyselyOf, openRaw } from '../../storage/db.ts';
import { createLogger } from '../../logging/logger.ts';
import { loadConfig } from '../../config/config.ts';
import { buildServer } from '../../server.ts';
import { acquireServiceLock } from '../setup/reset.ts';
import { keyIdOf, Vault } from './vault.ts';
import { finishVaultChange, resetVault } from './lifecycle.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const logger = createLogger({ sink: () => undefined });
async function fixture() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const { db, raw } = await testDb(t.dir);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await db.destroy();
    }
  };
  cleanups.push(close);
  const key = randomBytes(32),
    nextKey = randomBytes(32);
  const vault = await Vault.start(db, key);
  cleanups.push(() => vault.close());
  await vault.initialise(db);
  const at = new Date().toISOString();
  const future = new Date(Date.now() + 86400000).toISOString();
  await db
    .insertInto('nodes')
    .values({
      id: 'n1',
      name: 'test',
      chain: 'bitcoin',
      network: 'regtest',
      implementation: 'cln',
      url: 'https://localhost',
      ca_certificate: '',
      server_name: 'localhost',
      pubkey: '02' + 'aa'.repeat(32),
      identity_state: 'confirmed',
      identity_failed_check: null,
      identity_detail: null,
      identity_checked_at: at,
      created_at: at,
    })
    .execute();
  await vault.put(db, 'n1', 'read', 'view-canary');
  await vault.put(db, 'n1', 'spend', 'spend-canary');
  await db
    .insertInto('auth_totp')
    .values({ id: 1, ...vault.sealSecret('totp-canary', 'totp'), last_counter: '100' })
    .execute();
  const token = vault.sealSecret('telegram-canary', 'telegram_token');
  await db
    .insertInto('settings')
    .values({
      key: 'setup_alerts',
      value: JSON.stringify({
        kind: 'telegram',
        pending: true,
        key_id: token.key_id,
        nonce: token.nonce.toString('base64'),
        ciphertext: token.ciphertext.toString('base64'),
      }),
    })
    .execute();
  const psbt = vault.sealSecret('psbt-canary', 'intent_psbt:i1');
  await db
    .insertInto('spend_intents')
    .values({
      id: 'i1',
      node_id: 'n1',
      chain: 'bitcoin',
      pubkey: '02' + 'aa'.repeat(32),
      type: 'onchain',
      payment_hash: null,
      amount_msat: '1000',
      max_fee_msat: '1000',
      fee_msat: null,
      state: 'unknown',
      idempotency_key: 'replay',
      digest: 'digest',
      error_code: null,
      created_at: at,
      updated_at: at,
      psbt_key_id: psbt.key_id,
      psbt_nonce: psbt.nonce,
      psbt_ciphertext: psbt.ciphertext,
    })
    .execute();
  await db.insertInto('owner').values({ id: 1, password_hash: 'hash', created_at: at }).execute();
  await db.insertInto('recovery_codes').values({ code_hash: 'hash', used_at: null }).execute();
  await db
    .insertInto('sessions')
    .values({ id_hash: 'session', handle: 'handle', created_at: at, last_seen_at: at, expires_at: future })
    .execute();
  await db
    .insertInto('known_devices')
    .values({ id_hash: 'device', created_at: at, last_seen_at: at, expires_at: future })
    .execute();
  await db.insertInto('setup_token').values({ id: 1, token_hash: 'token', expires_at: future }).execute();
  await db
    .insertInto('login_throttles')
    .values({
      counter: 'global',
      kind: 'global',
      failures: 30,
      next_allowed_at: Date.now() + 60000,
      last_failed_at: Date.now(),
    })
    .execute();
  await db
    .insertInto('settings')
    .values({ key: 'session_policy', value: '{"idleSeconds":900,"absoluteSeconds":86400}' })
    .execute();
  await db
    .insertInto('spend_limits')
    .values({
      chain: 'bitcoin',
      pubkey: '02' + 'aa'.repeat(32),
      max_per_payment_sat: '10000',
      max_24h_sat: '20000',
      step_up_above_sat: '1000',
      max_fee_rate: '10',
      max_fee_share_percent: 10,
      max_routing_fee_share_percent: 1,
      routing_fee_allowance_sat: '10',
    })
    .execute();
  return { ...t, raw, db, close, vault, key, nextKey };
}

describe('offline vault lifecycle', () => {
  it('rotates all sealed stores, preserves metadata and refuses the old key until file move', async () => {
    const f = await fixture();
    const before = await f.db.selectFrom('credentials').selectAll().execute();
    expect(await Vault.rotate(f.db, f.key, f.nextKey)).toEqual({
      previousId: keyIdOf(f.key),
      keyId: keyIdOf(f.nextKey),
    });
    await expect(Vault.start(f.db, f.key)).rejects.toThrow(keyIdOf(f.nextKey));
    const next = await Vault.start(f.db, f.nextKey);
    cleanups.push(() => next.close());
    expect(await next.get(f.db, 'n1', 'read')).toBe('view-canary');
    expect(await next.get(f.db, 'n1', 'spend')).toBe('spend-canary');
    const totp = await f.db.selectFrom('auth_totp').selectAll().executeTakeFirstOrThrow();
    expect(next.openSecret(totp, 'totp')).toBe('totp-canary');
    expect(totp.last_counter).toBe('100');
    const alerts = JSON.parse(
      (await f.db.selectFrom('settings').select('value').where('key', '=', 'setup_alerts').executeTakeFirstOrThrow())
        .value,
    ) as { key_id: string; nonce: string; ciphertext: string; pending: boolean };
    expect(alerts.pending).toBe(true);
    expect(
      next.openSecret(
        { ...alerts, nonce: Buffer.from(alerts.nonce, 'base64'), ciphertext: Buffer.from(alerts.ciphertext, 'base64') },
        'telegram_token',
      ),
    ).toBe('telegram-canary');
    const intent = await f.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow();
    expect(
      next.openSecret(
        {
          key_id: intent.psbt_key_id ?? '',
          nonce: intent.psbt_nonce ?? new Uint8Array(),
          ciphertext: intent.psbt_ciphertext ?? new Uint8Array(),
        },
        'intent_psbt:i1',
      ),
    ).toBe('psbt-canary');
    expect(intent.state).toBe('unknown');
    expect(intent.idempotency_key).toBe('replay');
    expect(await f.db.selectFrom('owner').selectAll().execute()).toHaveLength(1);
    const backups = join(f.dir, 'backups');
    mkdirSync(backups);
    writeFileSync(join(backups, 'pre-old.sqlite'), 'old');
    writeFileSync(join(backups, 'unrelated'), 'keep');
    finishVaultChange(f.raw, f.dir, logger);
    expect(existsSync(join(backups, 'pre-old.sqlite'))).toBe(false);
    expect(existsSync(join(backups, 'unrelated'))).toBe(true);
    for (const row of before)
      expect(readFileSync(join(f.dir, 'test.db')).includes(Buffer.from(row.ciphertext))).toBe(false);
    expect(readFileSync(join(f.dir, 'test.db-wal')).length).toBe(0);
    expect(f.raw.prepare('PRAGMA secure_delete').all([])).toEqual([{ secure_delete: 1 }]);
  });
  it.each(['totp', 'telegram', 'psbt', 'missing-psbt'] as const)(
    'rolls back partial writes when %s cannot authenticate',
    async (kind) => {
      const f = await fixture();
      const before = await f.db.selectFrom('credentials').selectAll().execute();
      if (kind === 'totp')
        await f.db
          .updateTable('auth_totp')
          .set({ ciphertext: randomBytes(20) })
          .execute();
      if (kind === 'telegram')
        await f.db
          .updateTable('settings')
          .set({ value: '{"kind":"telegram"}' })
          .where('key', '=', 'setup_alerts')
          .execute();
      if (kind === 'psbt') await f.db.updateTable('spend_intents').set({ psbt_key_id: 'wrong-key' }).execute();
      if (kind === 'missing-psbt') await f.db.updateTable('spend_intents').set({ psbt_key_id: '' }).execute();
      await expect(Vault.rotate(f.db, f.key, f.nextKey)).rejects.toThrow();
      expect(await f.db.selectFrom('credentials').selectAll().execute()).toEqual(before);
      const old = await Vault.start(f.db, f.key);
      old.close();
    },
  );
  it('rolls back an injected failure inside the rotation transaction', async () => {
    const f = await fixture();
    const before = await f.db.selectFrom('credentials').selectAll().execute();
    f.raw.exec(
      "CREATE TRIGGER fail_rotation BEFORE UPDATE ON settings WHEN NEW.key = 'vault_key_id' BEGIN SELECT RAISE(ABORT, 'injected crash'); END",
    );
    await expect(Vault.rotate(f.db, f.key, f.nextKey)).rejects.toThrow('injected crash');
    expect(await f.db.selectFrom('credentials').selectAll().execute()).toEqual(before);
    const old = await Vault.start(f.db, f.key);
    old.close();
  });
  it('survives a real process kill after a row rewrite before commit', async () => {
    const f = await fixture();
    const before = await f.db.selectFrom('credentials').selectAll().execute();
    const oldFile = writeVaultKey(f.dir, f.key);
    const newFile = join(f.dir, 'new-key');
    writeFileSync(newFile, f.nextKey.toString('hex') + '\n');
    await f.close();
    const child = new URL('./fixtures/rotate-crash.ts', import.meta.url).pathname;
    let signal: unknown;
    try {
      execFileSync(process.execPath, [child, join(f.dir, 'test.db'), oldFile, newFile], {
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch (err) {
      signal = (err as { signal: unknown }).signal;
    }
    expect(signal).toBe('SIGKILL');
    const db = kyselyOf(await openRaw(join(f.dir, 'test.db'), testDriver()));
    cleanups.push(() => db.destroy());
    expect(await db.selectFrom('credentials').selectAll().execute()).toEqual(before);
    const old = await Vault.start(db, f.key);
    expect(await old.get(db, 'n1', 'read')).toBe('view-canary');
    old.close();
    await expect(Vault.start(db, f.nextKey)).rejects.toThrow(keyIdOf(f.key));
  }, 20000);
  it('supports absent optional stores and preserves unencrypted alerts', async () => {
    const f = await fixture();
    await f.db.deleteFrom('auth_totp').execute();
    await f.db.deleteFrom('spend_intents').execute();
    await f.db.updateTable('settings').set({ value: '{"kind":"none"}' }).where('key', '=', 'setup_alerts').execute();
    await Vault.rotate(f.db, f.key, f.nextKey);
    await f.db.deleteFrom('settings').where('key', '=', 'setup_alerts').execute();
    await Vault.rotate(f.db, f.nextKey, f.key);
  });
  it('rejects same-key rotation, uninitialised vault, and missing canary with PSBT as the only sealed store', async () => {
    const f = await fixture();
    await expect(Vault.rotate(f.db, f.key, f.key)).rejects.toThrow('differ');
    await f.db.deleteFrom('credentials').execute();
    await f.db.deleteFrom('auth_totp').execute();
    await f.db.deleteFrom('settings').execute();
    await expect(Vault.start(f.db, f.key)).rejects.toThrow('canary missing');
    await f.db.deleteFrom('spend_intents').execute();
    await expect(Vault.rotate(f.db, f.key, f.nextKey)).rejects.toThrow('not initialised');
  });
  it('resets without the old key and preserves nodes, policies, limits, history and unresolved budget', async () => {
    const f = await fixture();
    const history = await f.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow();
    const limits = await f.db.selectFrom('spend_limits').selectAll().execute();
    expect(await resetVault(f.db, f.nextKey)).toBe(keyIdOf(f.nextKey));
    for (const table of [
      'owner',
      'credentials',
      'auth_totp',
      'recovery_codes',
      'sessions',
      'known_devices',
      'setup_token',
      'login_throttles',
    ] as const)
      expect(await f.db.selectFrom(table).selectAll().execute()).toEqual([]);
    expect(await f.db.selectFrom('spend_limits').selectAll().execute()).toEqual(limits);
    expect(
      await f.db.selectFrom('settings').select('value').where('key', '=', 'session_policy').executeTakeFirstOrThrow(),
    ).toEqual({ value: '{"idleSeconds":900,"absoluteSeconds":86400}' });
    expect(await f.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow()).toEqual({
      ...history,
      psbt_key_id: null,
      psbt_nonce: null,
      psbt_ciphertext: null,
    });
    expect((await f.db.selectFrom('nodes').selectAll().executeTakeFirstOrThrow()).identity_detail).toContain(
      'Credentials needed',
    );
    const fresh = await Vault.start(f.db, f.nextKey);
    expect(fresh.initialised).toBe(true);
    fresh.close();
    finishVaultChange(f.raw, f.dir, logger);
  });
  it('distinguishes cleanup failure after commit from rollback', async () => {
    const f = await fixture();
    await Vault.rotate(f.db, f.key, f.nextKey);
    writeFileSync(join(f.dir, 'backups'), 'obstruct');
    expect(() => finishVaultChange(f.raw, f.dir, logger)).toThrow('change committed');
    const next = await Vault.start(f.db, f.nextKey);
    next.close();
    await expect(Vault.start(f.db, f.key)).rejects.toThrow('does not match');
  });
  it('CLI enforces offline lock and supports rotation, lost-key reset, file move and re-setup', async () => {
    const f = await fixture();
    const old = writeVaultKey(f.dir, f.key),
      newer = join(f.dir, 'new-key');
    writeFileSync(newer, f.nextKey.toString('hex') + '\n');
    await f.close();
    renameSync(join(f.dir, 'test.db'), join(f.dir, 'lightning-pilot.db'));
    const file = join(f.dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        tls: { mode: 'off' },
        paths: { dataDir: f.dir, vaultKey: old },
        log: { destination: 'stdout' },
      }),
    );
    const main = new URL('../../main.ts', import.meta.url).pathname;
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [main, ...args, '--config', file, '--dev'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    expect(run('vault', 'rotate', '--new-key-file', newer)).toContain('vault rotated');
    expect(() => run('setup-token')).toThrow();
    const release = acquireServiceLock(f.dir);
    try {
      expect(() => run('vault', 'reset', '--new-key-file', newer)).toThrow();
    } finally {
      release();
    }
    unlinkSync(old);
    const output = run('vault', 'reset', '--new-key-file', newer);
    expect(output).toContain('vault reset');
    expect(output).toContain('setupToken');
    renameSync(newer, old);
    expect(run('setup-token')).toContain('setupToken');
    const lines: string[] = [];
    const { config } = loadConfig({ argv: ['--config', file, '--dev'] });
    const server = await buildServer({
      config,
      vaultKeyPath: old,
      dev: true,
      logger: createLogger({ sink: (line) => lines.push(line) }),
      scryptCost: { log2N: 10, r: 8, p: 1 },
    });
    try {
      const token = (JSON.parse(lines.find((line) => line.includes('"setupToken"')) ?? '{}') as { setupToken: string })
        .setupToken;
      await setupForTest(server.setup, token, 'New-password1!');
      expect(server.auth.setupMode).toBe(false);
      expect(await server.db.selectFrom('nodes').selectAll().execute()).toHaveLength(1);
      expect((await server.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow()).state).toBe('unknown');
    } finally {
      await server.close();
    }
  }, 20000);
});
