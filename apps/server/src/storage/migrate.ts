// Plain SQL migrations, applied in name order at start. File names: <UTC timestamp>_<module>_<what>.sql. Each file
// runs whole inside its own BEGIN IMMEDIATE transaction, together with its record. Applied files are checksummed:
// an edited or deleted applied migration stops start-up (never edit a merged migration; add a new one).
// Before the first pending migration of an existing database, a backup is written with VACUUM INTO (update and
// rollback spec §3): only the backup of the latest update is kept, and a failed migration names it.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawDb } from './db.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const NAME = /^[0-9]{8}T[0-9]{4}_[a-z0-9]+_[a-z0-9_]+\.sql$/;

export class MigrationError extends Error {}

export interface BackupOptions {
  // Directory of the pre-update backups (`<dataDir>/backups`).
  dir: string;
  now?: () => Date;
}

const BACKUP = /^pre-.*\.sqlite$/;
// The app version is not bumped per change yet, so a backup is named after the last applied and the last pending
// migration (their timestamps), plus the time it was taken.
const stamp = (name: string) => name.slice(0, 13);

function latestBackup(dir: string | undefined): string | undefined {
  if (dir === undefined) return undefined;
  try {
    return readdirSync(dir)
      .filter((f) => BACKUP.test(f))
      .sort()
      .at(-1);
  } catch {
    return undefined;
  }
}

function writeBackup(raw: RawDb, backup: BackupOptions, from: string, to: string): string {
  mkdirSync(backup.dir, { recursive: true, mode: 0o700 });
  // The same update retried after a failed migration (a service restart): its backup from before the first attempt is
  // the one the previous version can open; a new one would already hold the migrations that did apply.
  const retried = readdirSync(backup.dir)
    .filter((f) => BACKUP.test(f) && f.includes(`-to-${stamp(to)}-`))
    .sort()
    .at(0);
  if (retried !== undefined) return join(backup.dir, retried);
  const at = (backup.now?.() ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const name = `pre-${stamp(from)}-to-${stamp(to)}-${at}.sqlite`;
  const file = join(backup.dir, name);
  // VACUUM INTO cannot run inside a transaction and takes a file name as an SQL string.
  raw.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  chmodSync(file, 0o600);
  return file;
}

// Only the backup of the latest update is kept; older ones go once every migration of the update has applied.
function pruneBackups(dir: string, kept: string): void {
  for (const old of readdirSync(dir)) if (BACKUP.test(old) && join(dir, old) !== kept) unlinkSync(join(dir, old));
}

export function migrate(raw: RawDb, dir: string = MIGRATIONS_DIR, backup?: BackupOptions): string[] {
  raw.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT',
  );
  const all = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const misnamed = all.filter((f) => !NAME.test(f));
  if (misnamed.length > 0) throw new MigrationError(`migration file names not recognised: ${misnamed.join(', ')}`);
  const files = all.sort();
  const rows = raw.prepare('SELECT name, checksum FROM schema_migrations').all([]) as {
    name: string;
    checksum: string;
  }[];
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  for (const name of applied.keys()) {
    if (!files.includes(name)) {
      const restore = latestBackup(backup?.dir);
      throw new MigrationError(
        `database was upgraded by a newer Lightning Pilot (applied migration ${name} is missing from this version); ` +
          `install that version or newer${restore === undefined ? '' : `, or restore ${join(backup?.dir ?? '', restore)}`}`,
      );
    }
  }
  const pending = files.filter((name) => !applied.has(name));
  const last = [...applied.keys()].sort().at(-1);
  // A fresh database has nothing to lose.
  const saved =
    backup !== undefined && last !== undefined && pending.length > 0
      ? writeBackup(raw, backup, last, pending.at(-1) as string)
      : undefined;
  const done: string[] = [];
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8');
    const checksum = createHash('sha256').update(text).digest('hex');
    if (applied.has(name)) {
      if (applied.get(name) !== checksum) throw new MigrationError(`applied migration ${name} was modified`);
      continue;
    }
    raw.exec('BEGIN IMMEDIATE');
    try {
      raw.exec(text);
      raw
        .prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)')
        .run([name, checksum, new Date().toISOString()]);
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw new MigrationError(
        `migration ${name} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}` +
          (saved === undefined ? '' : `; the database before this update is in ${saved}`),
        { cause: err },
      );
    }
    done.push(name);
  }
  if (saved !== undefined && backup !== undefined) pruneBackups(backup.dir, saved);
  return done;
}
