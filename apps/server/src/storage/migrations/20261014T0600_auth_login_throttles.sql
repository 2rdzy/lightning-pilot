CREATE TABLE login_throttles (
  counter TEXT PRIMARY KEY CHECK(length(counter) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK(kind IN ('device', 'ip', 'tor', 'global')),
  failures INTEGER NOT NULL CHECK(failures BETWEEN 1 AND CASE WHEN kind = 'global' THEN 33 ELSE 11 END),
  next_allowed_at INTEGER NOT NULL CHECK(next_allowed_at >= 0),
  last_failed_at INTEGER NOT NULL CHECK(last_failed_at >= 0),
  CHECK((kind = 'global') = (counter = 'global'))
) STRICT;
CREATE INDEX login_throttles_retention ON login_throttles(kind, last_failed_at, counter);
ALTER TABLE known_devices ADD COLUMN source TEXT NOT NULL DEFAULT 'setup' CHECK(length(source) BETWEEN 1 AND 80);
