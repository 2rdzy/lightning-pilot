-- Setup-token sources and the account-wide second-factor counter share the login counter table. SQLite cannot
-- change a CHECK constraint in place, so the table is rebuilt with the same rows.
CREATE TABLE login_throttles_new (
  counter TEXT PRIMARY KEY CHECK(length(counter) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK(kind IN ('device', 'ip', 'tor', 'global', 'setup', 'factor')),
  failures INTEGER NOT NULL CHECK(failures BETWEEN 1 AND CASE WHEN kind = 'global' THEN 33 ELSE 11 END),
  next_allowed_at INTEGER NOT NULL CHECK(next_allowed_at >= 0),
  last_failed_at INTEGER NOT NULL CHECK(last_failed_at >= 0),
  CHECK((kind = 'global') = (counter = 'global')),
  CHECK((kind = 'factor') = (counter = 'factor'))
) STRICT;
INSERT INTO login_throttles_new SELECT counter, kind, failures, next_allowed_at, last_failed_at FROM login_throttles;
DROP TABLE login_throttles;
ALTER TABLE login_throttles_new RENAME TO login_throttles;
CREATE INDEX login_throttles_retention ON login_throttles(kind, last_failed_at, counter);
