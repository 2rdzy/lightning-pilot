// restore module: the server's side of restoring the database from a backup (update and rollback spec §4). The
// install script's `restore` mode copies a backup over the database and writes `<dataDir>/restore.json`. At the next
// start, before anything else reads the database, the marker is consumed once: the restore is recorded, every session
// and known device is revoked (a restored database could bring back revoked ones), and each node identity gets a
// pending reconciliation that keeps spending refused until the spend module has counted that node's recent spends.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeTx, type Db } from '../../storage/db.ts';
import type { Logger } from '../../logging/logger.ts';

export const RESTORE_MARKER = 'restore.json';
// How long the spends counted from the node after a restore count against the limits: the rolling window.
export const RESTORE_WINDOW_MS = 86_400_000;

// Written by the install script. After a rollback an older server reads a marker written by a newer script, so the
// format only ever gains optional fields; `version` stays 1 while it is compatible.
const Marker = z.object({
  version: z.literal(1),
  restoredAt: z.iso.datetime(),
  backupFile: z.string().min(1).max(500),
});

export class RestoreError extends Error {}

// Returns the restore id when a marker was consumed (or had been recorded before a crash), else undefined.
export async function consumeRestoreMarker(
  db: Db,
  dataDir: string,
  logger: Logger,
  now: () => Date = () => new Date(),
): Promise<string | undefined> {
  const file = join(dataDir, RESTORE_MARKER);
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  let marker: z.infer<typeof Marker>;
  try {
    marker = Marker.parse(JSON.parse(text));
  } catch {
    // Fail closed: a restore whose spends cannot be reconciled must not start serving.
    throw new RestoreError(`${file} is not a valid restore marker; fix or remove it after checking the restore`);
  }
  const hash = createHash('sha256').update(text).digest('hex');
  const log = logger.child('restore');
  const recorded = await writeTx(db, async (trx) => {
    // A crash between the commit and the unlink below reads the same marker again: record it once.
    const seen = await trx.selectFrom('restores').select('id').where('marker_hash', '=', hash).executeTakeFirst();
    if (seen) return { id: seen.id, fresh: false };
    const id = randomUUID();
    const at = now();
    await trx
      .insertInto('restores')
      .values({
        id,
        marker_hash: hash,
        restored_at: marker.restoredAt,
        backup_file: marker.backupFile,
        recorded_at: at.toISOString(),
      })
      .execute();
    await trx.deleteFrom('sessions').execute();
    await trx.deleteFrom('known_devices').execute();
    const identities = await trx.selectFrom('nodes').select(['chain', 'pubkey']).distinct().execute();
    for (const identity of identities)
      await trx
        .insertInto('restore_counts')
        .values({
          restore_id: id,
          chain: identity.chain,
          pubkey: identity.pubkey,
          state: 'pending',
          counted_msat: null,
          counted_at: null,
          until: new Date(at.getTime() + RESTORE_WINDOW_MS).toISOString(),
        })
        .execute();
    return { id, fresh: true, nodes: identities.length };
  });
  unlinkSync(file);
  if (recorded.fresh)
    log.warn('database restored from a backup', {
      restoreId: recorded.id,
      security: true,
      backupFile: marker.backupFile,
      restoredAt: marker.restoredAt,
      nodes: recorded.nodes,
    });
  return recorded.id;
}
