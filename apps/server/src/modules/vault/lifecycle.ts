import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../logging/logger.ts';
import { writeTx, type Db, type RawDb } from '../../storage/db.ts';
import { Vault, VaultError } from './vault.ts';

export async function resetVault(db: Db, newKey: Buffer): Promise<string> {
  return writeTx(db, async (trx) => {
    await trx.deleteFrom('credentials').execute();
    await trx.deleteFrom('auth_totp').execute();
    await trx.deleteFrom('recovery_codes').execute();
    await trx.deleteFrom('sessions').execute();
    await trx.deleteFrom('known_devices').execute();
    await trx.deleteFrom('login_throttles').execute();
    await trx.deleteFrom('owner').execute();
    await trx.deleteFrom('setup_token').execute();
    await trx.deleteFrom('settings').where('key', 'in', ['vault_key_id', 'vault_canary', 'setup_alerts']).execute();
    await trx
      .updateTable('spend_intents')
      .set({ psbt_key_id: null, psbt_nonce: null, psbt_ciphertext: null })
      .execute();
    await trx
      .updateTable('nodes')
      .set({
        identity_state: 'waiting',
        identity_failed_check: null,
        identity_detail: 'Credentials needed after vault reset',
      })
      .execute();
    const vault = await Vault.start(trx, newKey);
    try {
      await vault.initialise(trx);
      return vault.keyId;
    } finally {
      vault.close();
    }
  });
}

// Outside the transaction: failure must not suggest that the old key can still open the database.
export function finishVaultChange(raw: RawDb, dataDir: string, logger: Logger): void {
  try {
    const dir = join(dataDir, 'backups');
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      files = [];
    }
    let removed = 0;
    for (const file of files)
      if (/^pre-.*\.sqlite$/.test(file)) {
        unlinkSync(join(dir, file));
        removed++;
      }
    if (removed)
      logger.child('vault').warn('pre-update backup removed after vault change', { security: true, count: removed });
    const result = raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all([]) as { busy: number }[];
    if (result[0]?.busy !== 0) throw new Error('checkpoint busy');
  } catch {
    throw new VaultError(
      'vault change committed, but backup/WAL cleanup failed; keep the new key and finish cleanup before restarting',
    );
  }
}
