// Money: every amount is millisatoshi as a bigint in code and a decimal string in JSON. JavaScript numbers lose
// precision above 2^53, so no amount is ever a number. This module is the only place that converts or does
// arithmetic on amounts.
import { z } from 'zod';

export type Msat = bigint & { readonly __msat: unique symbol };

// 21 million BTC in msat has 19 digits; 21 digits leaves room without allowing absurd values.
const MSAT_PATTERN = /^(0|[1-9][0-9]{0,20})$/;

export const MsatString = z
  .string()
  .regex(MSAT_PATTERN, 'an amount in millisatoshi as a decimal string')
  .meta({ description: 'Amount in millisatoshi, as a decimal string', example: '1000' });
export type MsatString = z.infer<typeof MsatString>;

export class MoneyError extends Error {}

export function msat(value: bigint): Msat {
  if (value < 0n) throw new MoneyError('amount below zero');
  return value as Msat;
}

export function parseMsat(text: string): Msat {
  if (!MSAT_PATTERN.test(text)) throw new MoneyError('not an amount in millisatoshi');
  return BigInt(text) as Msat;
}

export const toMsatString = (value: Msat): MsatString => value.toString();

export const satToMsat = (sat: bigint): Msat => msat(sat * 1000n);

export const ZERO = 0n as Msat;

export const add = (...values: Msat[]): Msat => values.reduce<bigint>((a, b) => a + b, 0n) as Msat;

export function sub(a: Msat, b: Msat): Msat {
  if (b > a) throw new MoneyError('amount below zero');
  return (a - b) as Msat;
}

export const max = (a: Msat, b: Msat): Msat => (a > b ? a : b);

// Parts per million of an amount, rounded up so a fee cap derived from it is never smaller than intended.
export function ppm(amount: Msat, partsPerMillion: bigint): Msat {
  return ((amount * partsPerMillion + 999_999n) / 1_000_000n) as Msat;
}
