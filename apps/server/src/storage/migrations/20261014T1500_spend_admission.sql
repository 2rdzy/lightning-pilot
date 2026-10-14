-- Live confirmation payloads are now in memory only. Old replay bindings cannot be attributed safely.
DELETE FROM spend_confirmations;
ALTER TABLE spend_limits ADD COLUMN max_fee_rate_mode TEXT NOT NULL DEFAULT 'refuse' CHECK(max_fee_rate_mode IN ('refuse','step-up'));
ALTER TABLE spend_limits ADD COLUMN max_fee_share_mode TEXT NOT NULL DEFAULT 'refuse' CHECK(max_fee_share_mode IN ('refuse','step-up'));
ALTER TABLE spend_limits ADD COLUMN max_routing_fee_mode TEXT NOT NULL DEFAULT 'refuse' CHECK(max_routing_fee_mode IN ('refuse','step-up'));
ALTER TABLE spend_intents ADD COLUMN cost_msat TEXT CHECK(cost_msat IS NULL OR (length(cost_msat) BETWEEN 1 AND 21 AND cost_msat NOT GLOB '*[^0-9]*' AND (cost_msat = '0' OR cost_msat NOT GLOB '0*')));
ALTER TABLE spend_intents ADD COLUMN destination TEXT;
ALTER TABLE spend_intents ADD COLUMN session_handle TEXT;
ALTER TABLE spend_intents ADD COLUMN confirmation_hash TEXT;
CREATE INDEX spend_intents_identity ON spend_intents(chain,pubkey,created_at);
CREATE INDEX spend_intents_hash_identity ON spend_intents(chain,pubkey,payment_hash,state);
