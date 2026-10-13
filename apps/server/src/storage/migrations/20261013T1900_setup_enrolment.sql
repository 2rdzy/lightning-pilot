-- Enrolment commits with the owner in one transaction; no unverified draft is stored here.
CREATE TABLE auth_totp (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  last_counter TEXT NOT NULL
) STRICT;
CREATE TABLE recovery_codes (
  code_hash TEXT PRIMARY KEY,
  used_at TEXT
) STRICT;
-- No FK to nodes: policy survives removing and re-adding a node with the same identity.
CREATE TABLE spend_limits (
  chain TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  max_per_payment_sat TEXT CHECK (max_per_payment_sat IS NULL OR (
    length(max_per_payment_sat) BETWEEN 1 AND 18 AND max_per_payment_sat NOT GLOB '*[^0-9]*'
    AND (max_per_payment_sat = '0' OR substr(max_per_payment_sat, 1, 1) <> '0')
  )),
  max_24h_sat TEXT CHECK (max_24h_sat IS NULL OR (
    length(max_24h_sat) BETWEEN 1 AND 18 AND max_24h_sat NOT GLOB '*[^0-9]*'
    AND (max_24h_sat = '0' OR substr(max_24h_sat, 1, 1) <> '0')
  )),
  step_up_above_sat TEXT CHECK (step_up_above_sat IS NULL OR (
    length(step_up_above_sat) BETWEEN 1 AND 18 AND step_up_above_sat NOT GLOB '*[^0-9]*'
    AND (step_up_above_sat = '0' OR substr(step_up_above_sat, 1, 1) <> '0')
  )),
  max_fee_rate TEXT NOT NULL,
  max_fee_share_percent INTEGER NOT NULL,
  max_routing_fee_share_percent INTEGER NOT NULL,
  routing_fee_allowance_sat TEXT NOT NULL CHECK (
    length(routing_fee_allowance_sat) BETWEEN 1 AND 18 AND routing_fee_allowance_sat NOT GLOB '*[^0-9]*'
    AND (routing_fee_allowance_sat = '0' OR substr(routing_fee_allowance_sat, 1, 1) <> '0')
  ),
  PRIMARY KEY (chain, pubkey)
) STRICT;
CREATE TABLE known_devices (
  id_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

ALTER TABLE sessions ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(recovery_required IN (0,1));
