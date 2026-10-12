-- Node profiles and their credentials. Credentials are encrypted by the vault (AES-256-GCM); the additional data
-- binds each ciphertext to the key id, the node and the kind, so a value cannot be moved to another row.
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  chain TEXT NOT NULL CHECK (chain IN ('blake2b', 'bitcoin')),
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet4', 'signet', 'regtest')),
  implementation TEXT NOT NULL CHECK (implementation IN ('cln', 'lnd')),
  url TEXT NOT NULL,
  ca_certificate TEXT NOT NULL,
  server_name TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  identity_state TEXT NOT NULL CHECK (identity_state IN ('confirmed', 'waiting', 'refused')),
  identity_failed_check TEXT,
  identity_detail TEXT,
  identity_checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (chain, network, pubkey)
) STRICT;

CREATE TABLE credentials (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('read', 'spend')),
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  PRIMARY KEY (node_id, kind)
) STRICT;
