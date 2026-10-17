-- WP09c: the coins an on-chain send or a channel open was bounded with and told to spend (coin control), as a JSON
-- array of `txid:vout`, stored when the intent is admitted, before any node call. Recovery releases them when the
-- server stopped after `txprepare` reserved them but before the txid was stored. Not part of the export format: an
-- imported interrupted intent without coins keeps waiting for the owner, as before.
ALTER TABLE spend_intents ADD COLUMN utxos TEXT CHECK(utxos IS NULL OR (json_valid(utxos) AND json_type(utxos) = 'array'));
