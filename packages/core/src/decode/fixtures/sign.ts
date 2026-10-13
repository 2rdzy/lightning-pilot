// Test helper: writes and signs BOLT11 invoices field by field, so tests can make invoices that no node would (wrong
// lengths, unknown features, bit 512 on either chain) and that still carry a valid signature.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey, signAsync } from '@noble/secp256k1';
import { bech32 } from '@scure/base';
import { bytesToWords, wordsToBytesPadded } from '../words.ts';

// The key of the BOLT11 test vectors.
export const TEST_KEY = hexToBytes('e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734');
export const TEST_PUBKEY = getPublicKey(TEST_KEY);

export const TAGS = { p: 1, r: 3, '9': 5, x: 6, f: 9, d: 13, s: 16, n: 19, h: 23, c: 24, m: 27 } as const;

export const field = (tag: number, words: number[]): number[] => [tag, words.length >> 5, words.length & 31, ...words];
export const bytesField = (tag: number, bytes: Uint8Array): number[] => field(tag, bytesToWords(bytes));
export const textField = (tag: number, text: string): number[] => bytesField(tag, new TextEncoder().encode(text));

// Minimal big-endian words of a number.
export function numberWords(value: bigint): number[] {
  const words: number[] = [];
  for (let v = value; v > 0n; v >>= 5n) words.unshift(Number(v & 31n));
  return words;
}
export const featureWords = (bits: number[]): number[] => numberWords(bits.reduce((v, b) => v | (1n << BigInt(b)), 0n));

export const HASH = new Uint8Array(32).fill(1);
export const SECRET = new Uint8Array(32).fill(0x11);
// The usual fields of a valid invoice: payment hash, secret, description and the features nodes set.
export const BASE_FIELDS = (extra: number[][] = [], features = [8, 14, 17]): number[][] => [
  bytesField(TAGS.p, HASH),
  bytesField(TAGS.s, SECRET),
  textField(TAGS.d, 'test'),
  field(TAGS['9'], featureWords(features)),
  ...extra,
];

export interface SignOptions {
  key?: Uint8Array;
  timestamp?: number;
  // Replace the recovery id, or turn S into N - S (a high-S signature for the same key, with the recovery id flipped).
  recovery?: number;
  highS?: boolean;
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export async function signInvoice(hrp: string, fields: number[][], options: SignOptions = {}): Promise<string> {
  const timestamp = numberWords(BigInt(options.timestamp ?? 1_700_000_000)).slice(-7);
  while (timestamp.length < 7) timestamp.unshift(0);
  const data = [...timestamp, ...fields.flat()];
  const message = sha256(Uint8Array.of(...new TextEncoder().encode(hrp), ...wordsToBytesPadded(data)));
  const recovered = await signAsync(message, options.key ?? TEST_KEY, { prehash: false, format: 'recovered' });
  let recovery = recovered[0] ?? 0;
  const rs = recovered.slice(1);
  if (options.highS) {
    const s = N - BigInt(`0x${bytesToHex(rs.slice(32))}`);
    rs.set(hexToBytes(s.toString(16).padStart(64, '0')), 32);
    recovery ^= 1;
  }
  const signature = Uint8Array.of(...rs, options.recovery ?? recovery);
  return bech32.encode(hrp, [...data, ...bytesToWords(signature)], false);
}
