-- The single owner, the one-time setup token and server-side sessions. Only hashes of secrets are stored.
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE setup_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

-- id_hash: SHA-256 of the cookie value. handle: internal id that stays the same for the life of the session (spend
-- confirmations are bound to it).
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
