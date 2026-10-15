// Offline reset: the launcher takes the same file lock as the server and runs as the existing data owner.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeTx, type Db } from '../../storage/db.ts';
import type { Logger } from '../../logging/logger.ts';

// A separate SQLite file provides a process-lifetime OS lock. A crash releases it automatically; the app's WAL
// connection remains free for requests, and reset cannot run concurrently with either launcher.
export function acquireServiceLock(dataDir: string): () => void {
  const db = new DatabaseSync(join(dataDir, 'service-lock.db'));
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch {
    db.close();
    throw new Error('Lightning Pilot is already running; stop it first.');
  }
  return () => db.close();
}

export function requireDataOwner(dataDir: string): void {
  const file = join(dataDir, 'lightning-pilot.db');
  if (!existsSync(file)) throw new Error('No existing database to reset.');
  if (process.getuid && statSync(file).uid !== process.getuid())
    throw new Error('Run reset-auth as the service user that owns the database.');
}

export async function resetAuth(db: Db, logger: Logger): Promise<void> {
  await writeTx(db, async (trx) => {
    await trx.deleteFrom('sessions').execute();
    await trx.deleteFrom('known_devices').execute();
    await trx.deleteFrom('login_throttles').execute();
    await trx.deleteFrom('auth_totp').execute();
    await trx.deleteFrom('recovery_codes').execute();
    await trx.deleteFrom('owner').execute();
    await trx.deleteFrom('setup_token').execute();
  });
  logger.child('setup').warn('authentication reset', { security: true });
}
