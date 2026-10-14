-- The fee rate and percentages were checked only by the API schema. The table is rebuilt with the same rows and
-- database checks that match it: a positive decimal of at most 7 integer and 3 fractional digits, and percentages
-- in range. Rows written through the schema already meet them.
CREATE TABLE spend_limits_new (
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
  max_fee_rate TEXT NOT NULL CHECK (
    length(max_fee_rate) BETWEEN 1 AND 11 AND max_fee_rate NOT GLOB '*[^0-9.]*'
    AND max_fee_rate NOT GLOB '*.*.*' AND max_fee_rate NOT GLOB '.*' AND max_fee_rate NOT GLOB '*.'
    AND (instr(max_fee_rate, '.') = 0 OR length(max_fee_rate) - instr(max_fee_rate, '.') <= 3)
    AND (CASE WHEN instr(max_fee_rate, '.') = 0 THEN length(max_fee_rate) ELSE instr(max_fee_rate, '.') - 1 END) <= 7
    AND (max_fee_rate NOT GLOB '0*' OR max_fee_rate GLOB '0.*')
    AND CAST(max_fee_rate AS REAL) > 0
  ),
  max_fee_share_percent INTEGER NOT NULL CHECK (max_fee_share_percent BETWEEN 1 AND 100),
  max_routing_fee_share_percent INTEGER NOT NULL CHECK (max_routing_fee_share_percent BETWEEN 0 AND 100),
  routing_fee_allowance_sat TEXT NOT NULL CHECK (
    length(routing_fee_allowance_sat) BETWEEN 1 AND 18 AND routing_fee_allowance_sat NOT GLOB '*[^0-9]*'
    AND (routing_fee_allowance_sat = '0' OR substr(routing_fee_allowance_sat, 1, 1) <> '0')
  ),
  PRIMARY KEY (chain, pubkey)
) STRICT;
INSERT INTO spend_limits_new SELECT * FROM spend_limits;
DROP TABLE spend_limits;
ALTER TABLE spend_limits_new RENAME TO spend_limits;
