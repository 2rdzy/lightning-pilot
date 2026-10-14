-- On-chain sends, channel opens and channel closes become spend intents (WP09b). SQLite cannot change a CHECK in
-- place, so the table is rebuilt with every row and index. A payment hash is now required for BOLT11 only. New
-- columns: the transaction id, the PSBT of a prepared on-chain send sealed with the vault (deleted when the intent is
-- resolved), the channel id, the peer, and whether a close is forced. The close destination uses `destination`.
CREATE TABLE spend_intents_new (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  chain TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bolt11', 'onchain', 'channel-open', 'channel-close')),
  payment_hash TEXT CHECK ((type = 'bolt11') = (payment_hash IS NOT NULL)),
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
  updated_at TEXT NOT NULL,
  cost_msat TEXT CHECK(cost_msat IS NULL OR (length(cost_msat) BETWEEN 1 AND 21 AND cost_msat NOT GLOB '*[^0-9]*' AND (cost_msat = '0' OR cost_msat NOT GLOB '0*'))),
  destination TEXT,
  session_handle TEXT,
  confirmation_hash TEXT,
  preimage TEXT CHECK(preimage IS NULL OR (length(preimage) = 64 AND preimage NOT GLOB '*[^0-9a-f]*')),
  txid TEXT CHECK (txid IS NULL OR (length(txid) = 64 AND txid NOT GLOB '*[^0-9a-f]*')),
  psbt_key_id TEXT,
  psbt_nonce BLOB,
  psbt_ciphertext BLOB,
  channel_id TEXT CHECK (channel_id IS NULL OR (length(channel_id) = 64 AND channel_id NOT GLOB '*[^0-9a-f]*')),
  peer TEXT CHECK (peer IS NULL OR (length(peer) = 66 AND peer NOT GLOB '*[^0-9a-f]*')),
  close_force INTEGER CHECK (close_force IS NULL OR close_force IN (0, 1)),
  CHECK ((psbt_key_id IS NULL) = (psbt_nonce IS NULL) AND (psbt_nonce IS NULL) = (psbt_ciphertext IS NULL))
) STRICT;
INSERT INTO spend_intents_new (id, node_id, chain, pubkey, type, payment_hash, amount_msat, max_fee_msat, fee_msat,
  state, idempotency_key, digest, error_code, created_at, updated_at, cost_msat, destination, session_handle,
  confirmation_hash, preimage)
SELECT id, node_id, chain, pubkey, type, payment_hash, amount_msat, max_fee_msat, fee_msat, state, idempotency_key,
  digest, error_code, created_at, updated_at, cost_msat, destination, session_handle, confirmation_hash, preimage
FROM spend_intents;
DROP TABLE spend_intents;
ALTER TABLE spend_intents_new RENAME TO spend_intents;
CREATE INDEX spend_intents_node ON spend_intents(node_id, state);
CREATE INDEX spend_intents_identity ON spend_intents(chain,pubkey,created_at);
CREATE INDEX spend_intents_hash_identity ON spend_intents(chain,pubkey,payment_hash,state);
CREATE INDEX spend_intents_txid ON spend_intents(chain,pubkey,txid);
