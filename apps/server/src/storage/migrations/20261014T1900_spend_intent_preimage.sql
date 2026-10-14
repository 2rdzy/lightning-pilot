-- A same-key replay returns the same result as the first answer, including the proof of payment. Only a preimage
-- whose SHA-256 is the intent's payment hash is stored.
ALTER TABLE spend_intents ADD COLUMN preimage TEXT CHECK(preimage IS NULL OR (length(preimage) = 64 AND preimage NOT GLOB '*[^0-9a-f]*'));
