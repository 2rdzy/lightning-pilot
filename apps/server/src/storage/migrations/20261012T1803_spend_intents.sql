-- Spend confirmations (single-use tokens from a preview) and spend intents. Amounts are canonical decimal msat
-- strings, checked here as well as in code.
CREATE TABLE spend_confirmations (
  token_hash TEXT PRIMARY KEY,
  session_handle TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;

CREATE TABLE spend_intents (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  chain TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bolt11')),
  payment_hash TEXT NOT NULL,
  amount_msat TEXT NOT NULL CHECK (amount_msat GLOB '[0-9]*' AND amount_msat NOT GLOB '*[^0-9]*'
                                   AND (amount_msat = '0' OR amount_msat NOT GLOB '0*') AND length(amount_msat) <= 21),
  max_fee_msat TEXT NOT NULL CHECK (max_fee_msat GLOB '[0-9]*' AND max_fee_msat NOT GLOB '*[^0-9]*'
                                    AND (max_fee_msat = '0' OR max_fee_msat NOT GLOB '0*') AND length(max_fee_msat) <= 21),
  fee_msat TEXT CHECK (fee_msat IS NULL OR (fee_msat GLOB '[0-9]*' AND fee_msat NOT GLOB '*[^0-9]*'
                                    AND (fee_msat = '0' OR fee_msat NOT GLOB '0*') AND length(fee_msat) <= 21)),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'sent', 'succeeded', 'failed', 'unknown')),
  idempotency_key TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX spend_intents_node ON spend_intents(node_id, state);
