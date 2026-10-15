-- A restore of the database from a backup (update and rollback spec §4). The restored database does not know spends
-- made after the backup, so for 24 hours after the restore each node's recent spends are counted from the node
-- itself. `marker_hash` makes consuming the install script's marker idempotent; `recorded_at` (the server's clock
-- when it consumed the marker) anchors the 24-hour window; `restored_at` and `backup_file` are the installer's
-- values, kept for the audit only.
CREATE TABLE restores (
  id TEXT PRIMARY KEY,
  marker_hash TEXT NOT NULL UNIQUE,
  restored_at TEXT NOT NULL,
  backup_file TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;
-- One row per node identity known at the restore. `pending` refuses spending on that identity until it is counted
-- or until `until`; `counted` adds `counted_msat` to the identity's rolling window until `until`.
CREATE TABLE restore_counts (
  restore_id TEXT NOT NULL REFERENCES restores(id),
  chain TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'counted')),
  counted_msat TEXT CHECK (counted_msat IS NULL OR (length(counted_msat) BETWEEN 1 AND 21
                           AND counted_msat NOT GLOB '*[^0-9]*' AND (counted_msat = '0' OR counted_msat NOT GLOB '0*'))),
  counted_at TEXT,
  until TEXT NOT NULL,
  PRIMARY KEY (restore_id, chain, pubkey),
  CHECK ((state = 'counted') = (counted_msat IS NOT NULL))
) STRICT;
CREATE INDEX restore_counts_identity ON restore_counts(chain, pubkey, until);
