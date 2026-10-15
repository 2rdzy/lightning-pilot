// Test-only process: terminate after the first encrypted row rewrite, before SQLite can commit the rotation.
import Better from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { loadVaultKey, Vault } from '../vault.ts';
import type { DB } from '../../../storage/schema.ts';

const [file, oldFile, newFile] = process.argv.slice(2);
if (!file || !oldFile || !newFile) throw new Error('expected database and two key file paths');
const raw = new Better(file);
raw.function('crash_rotation', () => process.kill(process.pid, 'SIGKILL'));
raw.exec('CREATE TRIGGER crash_rotation AFTER UPDATE ON credentials BEGIN SELECT crash_rotation(); END');
const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
await Vault.rotate(db, loadVaultKey(oldFile), loadVaultKey(newFile));
throw new Error('rotation unexpectedly returned');
