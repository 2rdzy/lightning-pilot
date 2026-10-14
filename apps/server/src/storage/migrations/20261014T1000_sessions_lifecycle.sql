ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown' CHECK(length(source) <= 200);
ALTER TABLE sessions ADD COLUMN ended_at TEXT;
ALTER TABLE sessions ADD COLUMN end_reason TEXT CHECK(end_reason IN ('logout','revoked','expired','everywhere','recovery','security_change','step_up_failures'));
ALTER TABLE sessions ADD COLUMN step_up_failures INTEGER NOT NULL DEFAULT 0 CHECK(step_up_failures >= 0 AND step_up_failures <= 5);
ALTER TABLE sessions ADD COLUMN step_up_retry_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_ended_at ON sessions(ended_at);

-- Public device handles are independent of cookie digests. Rebuild to give old and future rows random handles.
CREATE TABLE known_devices_next (
  id_hash TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
  ),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'setup' CHECK(length(source) <= 200)
) STRICT;
INSERT INTO known_devices_next(id_hash,created_at,last_seen_at,expires_at,source)
  SELECT id_hash,created_at,last_seen_at,expires_at,source FROM known_devices;
DROP TABLE known_devices;
ALTER TABLE known_devices_next RENAME TO known_devices;
