// Test helpers shared by the server's tests (not used at run time).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kyselyOf, openRaw, type Driver } from './storage/db.ts';
import { migrate } from './storage/migrate.ts';

// The test job runs the server's tests a second time on better-sqlite3 (TEST_SQLITE_DRIVER=better-sqlite3).
export const testDriver = (): Driver =>
  process.env.TEST_SQLITE_DRIVER === 'better-sqlite3' ? 'better-sqlite3' : 'node:sqlite';

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lp-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function testDb(dir: string) {
  const raw = await openRaw(join(dir, 'test.db'), testDriver());
  migrate(raw);
  return { raw, db: kyselyOf(raw) };
}

export function writeVaultKey(dir: string, key: Buffer = randomBytes(32)): string {
  const path = join(dir, 'vault-key');
  writeFileSync(path, key.toString('hex') + '\n', { mode: 0o600 });
  return path;
}
