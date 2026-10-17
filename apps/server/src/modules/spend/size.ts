// The confirmed maximum fee of an on-chain send or a channel funding transaction (WP09c; spend policy §13 item 5):
// the confirmed fee rate times an upper bound of the transaction's size, computed from the node's own coins. The
// coins are chosen here and passed to the node (coin control), so the node cannot build a larger transaction than
// the one bounded: `txprepare` and `fundchannel` spend exactly the coins they are given.
import {
  AppError,
  decodeAddress,
  parseMsat,
  type AddressType,
  type Msat,
  type Network,
  type Utxo,
} from '@lightning-pilot/core';

// vbytes of one signed input, by the type of the coin's address. P2SH coins of a Core Lightning wallet are
// P2SH-wrapped P2WPKH (91 vB); a type the wallet does not sign alone (P2WSH) or an unknown address counts as the
// largest single-key input, P2PKH (148 vB), so the bound never comes out low.
export const INPUT_VBYTES: Record<AddressType, number> = { p2wpkh: 68, p2sh: 91, p2tr: 58, p2pkh: 148, p2wsh: 148 };
export const UNKNOWN_INPUT_VBYTES = 148;
// The change output: the largest standard script (P2TR or P2WSH, 34 bytes), whatever type the node picks.
export const CHANGE_SCRIPT_BYTES = 34;
// A channel's funding output: P2WSH, or P2TR for a taproot channel; both are 34-byte scripts (43 vB).
export const FUNDING_SCRIPT_BYTES = 34;
// Below this the node adds the change to the fee instead of creating an output (Bitcoin's dust limit for the
// largest standard output, as Core Lightning uses).
export const DUST_SAT = 546n;

const varint = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);

// vbytes of a segwit transaction: version and lock time (8), the input and output counts, the segwit marker and
// flag (half a vbyte, counted as one), then the inputs and outputs.
export function txVbytes(inputs: readonly number[], outputScriptBytes: readonly number[]): number {
  const outputs = outputScriptBytes.reduce((sum, len) => sum + 8 + varint(len) + len, 0);
  return 8 + varint(inputs.length) + varint(outputScriptBytes.length) + 1 + inputs.reduce((a, b) => a + b, 0) + outputs;
}

// ceil(rate × vbytes) in whole sats, as msat. `rate` has at most three decimals (FeeRateString).
export function feeForVbytes(rate: string, vbytes: number): Msat {
  const [whole, fraction = ''] = rate.split('.');
  const thousandths = BigInt(whole as string) * 1000n + BigInt(fraction.padEnd(3, '0'));
  const sats = (thousandths * BigInt(vbytes) + 999n) / 1000n;
  return parseMsat((sats * 1000n).toString());
}

export function inputVbytes(coin: Utxo, network: Network): number {
  if (coin.address === undefined) return UNKNOWN_INPUT_VBYTES;
  try {
    return INPUT_VBYTES[decodeAddress(coin.address, network).type];
  } catch {
    // Not an address of this network the decoder knows: counted as the largest input.
    return UNKNOWN_INPUT_VBYTES;
  }
}

export interface FeeBound {
  // The chosen coins, `txid:vout`, passed to the node as `utxos`.
  utxos: string[];
  maxFee: Msat;
}

// The fewest confirmed, unreserved coins (largest first) that pay `amount` plus the fee of a transaction with one
// output of `scriptBytes` and one change output. When the change left would be dust, the node adds it to the fee,
// so the bound is then everything the coins hold beyond the amount. If even all the coins pay the amount only
// without a change output, that is the transaction the node builds, with the same bound.
export function boundFee(
  coins: readonly Utxo[],
  network: Network,
  amount: Msat,
  rate: string,
  scriptBytes: number,
): FeeBound {
  const usable = coins
    .filter((c) => c.status === 'confirmed' && !c.reserved)
    .sort((a, b) => (a.amount === b.amount ? a.outpoint.localeCompare(b.outpoint) : a.amount > b.amount ? -1 : 1));
  const chosen: Utxo[] = [];
  const sizes: number[] = [];
  let sum = 0n;
  for (const coin of usable) {
    chosen.push(coin);
    sizes.push(inputVbytes(coin, network));
    sum += coin.amount;
    const withChange = feeForVbytes(rate, txVbytes(sizes, [scriptBytes, CHANGE_SCRIPT_BYTES]));
    const last = chosen.length === usable.length;
    if (sum >= amount + withChange) {
      const change = sum - amount - withChange;
      return {
        utxos: chosen.map((c) => c.outpoint),
        maxFee: change < DUST_SAT * 1000n ? parseMsat((sum - amount).toString()) : withChange,
      };
    }
    if (last && sum >= amount + feeForVbytes(rate, txVbytes(sizes, [scriptBytes])))
      return { utxos: chosen.map((c) => c.outpoint), maxFee: parseMsat((sum - amount).toString()) };
  }
  throw new AppError('validation_failed', "The wallet's confirmed coins do not cover the amount and the fee.", {
    reason: 'insufficient_funds',
  });
}

// The script length of an output paying `script` (hex).
export const scriptBytes = (script: string): number => script.length / 2;
