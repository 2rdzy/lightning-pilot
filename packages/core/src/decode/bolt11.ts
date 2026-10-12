// Minimal BOLT11 reader: network, amount, payment hash and expiry, read by us rather than trusted from the node that
// is about to pay. It does NOT check the signature, the feature bits (the bit-512 chain rule) or any other field;
// the complete decoder replaces it. Format: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
import { bytesToHex } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import type { Network } from '../domain.ts';
import { parsePaymentHash, type PaymentHash } from '../ids.ts';
import { msat, type Msat } from '../money.ts';

export class Bolt11Error extends Error {}

export interface Bolt11Basics {
  network: Network;
  amount?: Msat;
  paymentHash: PaymentHash;
  timestamp: number;
  expirySeconds: number;
  expiresAt: Date;
}

// Currency prefixes: "bcrt" and "tbs" must be tried before "bc" and "tb".
const PREFIXES: [string, Network][] = [
  ['bcrt', 'regtest'],
  ['tbs', 'signet'],
  ['bc', 'mainnet'],
  ['tb', 'testnet4'],
];

// msat per unit of each amount multiplier (1 BTC = 10^11 msat). The pico multiplier is a tenth of a msat.
const MULTIPLIER: Record<string, bigint> = { '': 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };

const SIGNATURE_WORDS = 104; // 65 bytes
const TIMESTAMP_WORDS = 7; // 35 bits
const TAG_PAYMENT_HASH = 1;
const TAG_EXPIRY = 6;
const DEFAULT_EXPIRY = 3600;

function readAmount(text: string): Msat | undefined {
  if (text === '') return undefined;
  const match = /^([1-9][0-9]*)([munp]?)$/.exec(text);
  if (!match) throw new Bolt11Error('invalid amount');
  const [, digits = '', unit = ''] = match;
  if (unit === 'p') {
    const pico = BigInt(digits);
    if (pico % 10n !== 0n) throw new Bolt11Error('amount is not a whole number of millisatoshi');
    return msat(pico / 10n);
  }
  const perUnit = MULTIPLIER[unit];
  if (perUnit === undefined) throw new Bolt11Error('invalid amount');
  return msat(BigInt(digits) * perUnit);
}

const wordsToNumber = (words: readonly number[]): number => words.reduce((n, w) => n * 32 + w, 0);

export function readBolt11(input: string): Bolt11Basics {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^lightning:/, '');
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(text as `${string}1${string}`, false);
  } catch {
    throw new Bolt11Error('not a BOLT11 invoice');
  }
  if (!decoded.prefix.startsWith('ln')) throw new Bolt11Error('not a BOLT11 invoice');
  const hrp = decoded.prefix.slice(2);
  const prefix = PREFIXES.find(([p]) => hrp.startsWith(p));
  if (!prefix) throw new Bolt11Error('unknown currency prefix');
  const [currency, network] = prefix;
  const amount = readAmount(hrp.slice(currency.length));

  const words = decoded.words;
  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) throw new Bolt11Error('invoice too short');
  const timestamp = wordsToNumber(words.slice(0, TIMESTAMP_WORDS));
  const fields = words.slice(TIMESTAMP_WORDS, words.length - SIGNATURE_WORDS);

  let paymentHash: PaymentHash | undefined;
  let expirySeconds = DEFAULT_EXPIRY;
  for (let i = 0; i < fields.length;) {
    if (i + 3 > fields.length) throw new Bolt11Error('truncated field');
    const tag = fields[i] ?? 0;
    const length = (fields[i + 1] ?? 0) * 32 + (fields[i + 2] ?? 0);
    const data = fields.slice(i + 3, i + 3 + length);
    if (data.length !== length) throw new Bolt11Error('truncated field');
    i += 3 + length;
    // A payment hash of the wrong length must be skipped, not used (BOLT11 "MUST skip").
    if (tag === TAG_PAYMENT_HASH && length === 52 && paymentHash === undefined) {
      paymentHash = parsePaymentHash(bytesToHex(bech32.fromWords(data)));
    } else if (tag === TAG_EXPIRY) {
      expirySeconds = wordsToNumber(data);
    }
  }
  if (!paymentHash) throw new Bolt11Error('invoice has no payment hash');
  const expiresAt = new Date((timestamp + expirySeconds) * 1000);
  return { network, ...(amount === undefined ? {} : { amount }), paymentHash, timestamp, expirySeconds, expiresAt };
}
