// Plain SQL migrations, applied in name order at start. File names: <UTC timestamp>_<module>_<what>.sql. Each file
// runs whole inside its own BEGIN IMMEDIATE transaction, together with its record. Applied files are checksummed:
// an edited or deleted applied migration stops start-up (never edit a merged migration; add a new one).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawDb } from './db.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const NAME = /^[0-9]{8}T[0-9]{4}_[a-z0-9]+_[a-z0-9_]+\.sql$/;

export class MigrationError extends Error {}

export function migrate(raw: RawDb, dir: string = MIGRATIONS_DIR): string[] {
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
    if (!files.includes(name)) throw new MigrationError(`applied migration ${name} is missing`);
  }
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
      throw err;
    }
    done.push(name);
  }
  return done;
}
