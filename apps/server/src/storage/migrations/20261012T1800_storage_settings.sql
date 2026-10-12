-- Key-value settings (vault key id and canary, instance-wide values). Values never hold secrets in plain text.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
