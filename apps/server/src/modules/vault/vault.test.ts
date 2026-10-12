import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, testDb } from '../../testing.ts';
import { keyIdOf, loadVaultKey, Vault, VaultError } from './vault.ts';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function dir() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

async function nodeRow(db: Awaited<ReturnType<typeof testDb>>['db'], id: string) {
  const now = new Date().toISOString();
  await db
    .insertInto('nodes')
    .values({
      id,
      name: id,
      chain: 'blake2b',
      network: 'regtest',
      implementation: 'cln',
      url: 'https://x',
      ca_certificate: '',
      server_name: 'localhost',
      pubkey: '02' + id.padStart(64, '0'),
      identity_state: 'confirmed',
      identity_failed_check: null,
      identity_detail: null,
      identity_checked_at: now,
      created_at: now,
    })
    .execute();
}

describe('vault key file', () => {
  it('accepts 64 hex characters with or without a newline', () => {
    const d = dir();
    const key = randomBytes(32);
    writeFileSync(join(d, 'a'), key.toString('hex'));
    writeFileSync(join(d, 'b'), key.toString('hex') + '\n');
    expect(loadVaultKey(join(d, 'a'))).toEqual(key);
    expect(loadVaultKey(join(d, 'b'))).toEqual(key);
  });

  it('refuses a missing file and malformed content', () => {
    const d = dir();
    expect(() => loadVaultKey(join(d, 'missing'))).toThrow('vault key not provided');
    const hex = randomBytes(32).toString('hex');
    for (const bad of [hex.slice(1), hex + 'a', hex.toUpperCase(), 'z'.repeat(64), hex + '\nextra', hex + '\n\n']) {
      writeFileSync(join(d, 'k'), bad);
      expect(() => loadVaultKey(join(d, 'k')), bad).toThrow('vault key malformed');
    }
  });

  it('never reads the key from the environment', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./vault.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/process\.env/);
  });
});

describe('vault start-up checks', () => {
  it('starts uninitialised on an empty database without writing a canary', async () => {
    const { db } = await testDb(dir());
    const vault = await Vault.start(db, randomBytes(32));
    expect(vault.initialised).toBe(false);
    expect(await db.selectFrom('settings').selectAll().execute()).toEqual([]);
  });

  it('opens with the right key after initialisation', async () => {
    const { db } = await testDb(dir());
    const key = randomBytes(32);
    await (await Vault.start(db, key)).initialise(db);
    expect((await Vault.start(db, key)).initialised).toBe(true);
  });

  it('refuses a different key, naming both key ids', async () => {
    const { db } = await testDb(dir());
    const key = randomBytes(32);
    await (await Vault.start(db, key)).initialise(db);
    const other = randomBytes(32);
    await expect(Vault.start(db, other)).rejects.toThrow(
      `vault key ${keyIdOf(other)} does not match this database (${keyIdOf(key)})`,
    );
  });

  it('refuses a canary that does not decrypt', async () => {
    const { db } = await testDb(dir());
    const key = randomBytes(32);
    await (await Vault.start(db, key)).initialise(db);
    const canary = (
      await db.selectFrom('settings').select('value').where('key', '=', 'vault_canary').executeTakeFirstOrThrow()
    ).value;
    const damaged = Buffer.from(canary, 'base64');
    damaged.writeUInt8(damaged.readUInt8(damaged.length - 1) ^ 1, damaged.length - 1);
    await db
      .updateTable('settings')
      .set({ value: damaged.toString('base64') })
      .where('key', '=', 'vault_canary')
      .execute();
    await expect(Vault.start(db, key)).rejects.toThrow('wrong vault key or damaged database');
  });

  it('refuses credentials without a canary, never re-creating it', async () => {
    const { db } = await testDb(dir());
    const key = randomBytes(32);
    const vault = await Vault.start(db, key);
    await vault.initialise(db);
    await nodeRow(db, 'n1');
    await vault.put(db, 'n1', 'read', 'secret-rune');
    await db.deleteFrom('settings').execute();
    await expect(Vault.start(db, key)).rejects.toThrow('vault canary missing');
    expect(await db.selectFrom('settings').selectAll().execute()).toEqual([]);
  });
});

describe('vault encryption', () => {
  it('round-trips a credential, with a fresh nonce on every write', async () => {
    const { db } = await testDb(dir());
    const vault = await Vault.start(db, randomBytes(32));
    await vault.initialise(db);
    await nodeRow(db, 'n1');
    await vault.put(db, 'n1', 'spend', 'rune-1');
    const first = await db.selectFrom('credentials').select('nonce').executeTakeFirstOrThrow();
    await vault.put(db, 'n1', 'spend', 'rune-1');
    const second = await db.selectFrom('credentials').select(['nonce', 'ciphertext']).executeTakeFirstOrThrow();
    expect(Buffer.from(second.nonce).equals(Buffer.from(first.nonce))).toBe(false);
    expect(Buffer.from(second.ciphertext).toString('utf8')).not.toContain('rune-1');
    expect(await vault.get(db, 'n1', 'spend')).toBe('rune-1');
  });

  it('refuses a value moved to another row or kind (additional data)', async () => {
    const { db } = await testDb(dir());
    const vault = await Vault.start(db, randomBytes(32));
    await vault.initialise(db);
    await nodeRow(db, 'n1');
    await nodeRow(db, 'n2');
    await vault.put(db, 'n1', 'read', 'rune-1');
    const row = await db.selectFrom('credentials').selectAll().executeTakeFirstOrThrow();
    await db
      .insertInto('credentials')
      .values({ ...row, node_id: 'n2' })
      .execute();
    await db
      .insertInto('credentials')
      .values({ ...row, kind: 'spend' })
      .execute();
    await expect(vault.get(db, 'n2', 'read')).rejects.toThrow(VaultError);
    await expect(vault.get(db, 'n1', 'spend')).rejects.toThrow(VaultError);
  });

  it('refuses writes before initialisation', async () => {
    const { db } = await testDb(dir());
    const vault = await Vault.start(db, randomBytes(32));
    await expect(vault.put(db, 'n1', 'read', 'x')).rejects.toThrow('vault not initialised');
  });
});

describe('vault edge cases', () => {
  it('refuses a key id without a canary, and initialising twice', async () => {
    const { db } = await testDb(dir());
    const key = randomBytes(32);
    const vault = await Vault.start(db, key);
    await vault.initialise(db);
    await expect(vault.initialise(db)).rejects.toThrow('vault already initialised');
    await db.deleteFrom('settings').where('key', '=', 'vault_canary').execute();
    await expect(Vault.start(db, key)).rejects.toThrow('vault canary missing');
  });

  it('follows the database after reload (a setup transaction that rolled back)', async () => {
    const { db } = await testDb(dir());
    const vault = await Vault.start(db, randomBytes(32));
    await vault.initialise(db);
    expect(vault.initialised).toBe(true);
    await db.deleteFrom('settings').execute();
    await vault.reload(db);
    expect(vault.initialised).toBe(false);
  });

  it('returns nothing for a missing credential and refuses one stored under another key id or corrupted', async () => {
    const { db } = await testDb(dir());
    const vault = await Vault.start(db, randomBytes(32));
    await vault.initialise(db);
    await nodeRow(db, 'n1');
    expect(await vault.get(db, 'n1', 'read')).toBeUndefined();
    await vault.put(db, 'n1', 'read', 'rune-1');
    await db.updateTable('credentials').set({ key_id: '0000000000000000' }).execute();
    await expect(vault.get(db, 'n1', 'read')).rejects.toThrow('credential encrypted under another key');
    await db
      .updateTable('credentials')
      .set({ key_id: vault.keyId, nonce: Buffer.alloc(3) })
      .execute();
    await expect(vault.get(db, 'n1', 'read')).rejects.toThrow('corrupt value');
  });
});
