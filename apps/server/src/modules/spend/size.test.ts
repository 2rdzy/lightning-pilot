import { describe, expect, it } from 'vitest';
import { AppError, msat, parseFundingOutpoint, type Utxo } from '@lightning-pilot/core';
import { boundFee, feeForVbytes, inputVbytes, txVbytes } from './size.ts';

// Regtest addresses of each type (BIP173/BIP350 test vectors re-encoded for bcrt, and a P2SH one).
const P2WPKH = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
const P2TR = 'bcrt1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqc8gma6';
const P2SH = '2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc';

let n = 0;
const coin = (sats: bigint, address?: string, fields: Partial<Utxo> = {}): Utxo => ({
  outpoint: parseFundingOutpoint(`${(++n).toString(16).padStart(64, '0')}:0`),
  amount: msat(sats * 1000n),
  ...(address === undefined ? {} : { address }),
  status: 'confirmed',
  reserved: false,
  ...fields,
});

describe('size bound (WP09c)', () => {
  it('counts vbytes with real varints and output script lengths', () => {
    expect(txVbytes([68], [22, 34])).toBe(11 + 68 + 31 + 43);
    expect(txVbytes([], [])).toBe(11);
    expect(
      txVbytes(
        Array.from({ length: 253 }, () => 68),
        [22],
      ),
    ).toBe(8 + 3 + 1 + 1 + 253 * 68 + 31);
  });

  it('rounds the fee up to the whole sat, for rates with up to three decimals', () => {
    expect(feeForVbytes('2', 153)).toBe(306_000n);
    expect(feeForVbytes('1.012', 153)).toBe(155_000n); // 154.836
    expect(feeForVbytes('0.001', 1)).toBe(1_000n);
    expect(feeForVbytes('12.5', 141)).toBe(1_763_000n); // 1,762.5
  });

  it('sizes inputs by address type; unknown addresses count as the largest', () => {
    expect(inputVbytes(coin(1n, P2WPKH), 'regtest')).toBe(68);
    expect(inputVbytes(coin(1n, P2TR), 'regtest')).toBe(58);
    expect(inputVbytes(coin(1n, P2SH), 'regtest')).toBe(91);
    expect(inputVbytes(coin(1n), 'regtest')).toBe(148);
    expect(inputVbytes(coin(1n, 'not an address'), 'regtest')).toBe(148);
    expect(inputVbytes(coin(1n, P2WPKH), 'mainnet')).toBe(148);
  });

  it('picks the fewest confirmed, unreserved coins, largest first', () => {
    const small = coin(30_000n, P2WPKH),
      large = coin(100_000n, P2TR);
    const skipped = [
      coin(1_000_000n, P2WPKH, { reserved: true }),
      coin(1_000_000n, P2WPKH, { status: 'unconfirmed' }),
      coin(1_000_000n, P2WPKH, { status: 'immature' }),
    ];
    const one = boundFee([small, large, ...skipped], 'regtest', msat(50_000_000n), '2', 22);
    expect(one).toEqual({ utxos: [large.outpoint], maxFee: msat(286_000n) }); // (11 + 58 + 31 + 43) × 2
    const two = boundFee([small, large], 'regtest', msat(110_000_000n), '2', 22);
    expect(two.utxos).toEqual([large.outpoint, small.outpoint]);
    expect(two.maxFee).toBe(msat(422_000n)); // (11 + 58 + 68 + 31 + 43) × 2
  });

  it('bounds by everything beyond the amount when the change would be dust or impossible', () => {
    const only = coin(100_000n, P2WPKH);
    // 100,000 − 99,500 − 306 = 194 sat of change: dust, so the node adds it to the fee.
    expect(boundFee([only], 'regtest', msat(99_500_000n), '2', 22).maxFee).toBe(msat(500_000n));
    // Not enough for a change output at all, but enough without one: the node builds that transaction.
    expect(boundFee([only], 'regtest', msat(99_750_000n), '2', 22).maxFee).toBe(msat(250_000n));
  });

  it('refuses when the coins cannot pay the amount and the fee', () => {
    const run = () => boundFee([coin(10_000n, P2WPKH)], 'regtest', msat(9_900_000n), '2', 22);
    expect(run).toThrow(AppError);
    try {
      run();
    } catch (err) {
      expect(err).toMatchObject({ code: 'validation_failed', details: { reason: 'insufficient_funds' } });
    }
    expect(() => boundFee([], 'regtest', msat(1_000n), '1', 22)).toThrow(AppError);
  });
});
