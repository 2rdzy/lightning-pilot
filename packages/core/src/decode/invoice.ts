// Complete BOLT11 decoder: every field we use, the signature, and the feature bits, read by us rather than trusted
// from the node that is about to pay (threat model T18). Rules: https://github.com/lightning/bolts/blob/master/
// 11-payment-encoding.md (checked against commit 14901bd, 2026-03-09). The chain rule (bit 512) is applied by
// `checkInvoiceChain` (chain.ts), because it depends on the node's chain profile.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Point, recoverPublicKey, verify } from '@noble/secp256k1';
import { bech32 } from '@scure/base';
import type { Network } from '../domain.ts';
import { parsePaymentHash, parsePubkey, type PaymentHash, type Pubkey } from '../ids.ts';
import type { Msat } from '../money.ts';
import { untrustedText, type UntrustedText } from '../text.ts';
import { fallbackAddress, type AddressType } from './address.ts';
import { BOLT11_PREFIXES, MAX_EXPIRY, readAmount } from './bolt11.ts';
import { DecodeError } from './errors.ts';
import { wordsToBigInt, wordsToBytes, wordsToBytesPadded, wordsToNumber } from './words.ts';

export interface RouteHintHop {
  pubkey: Pubkey;
  shortChannelId: string;
  feeBaseMsat: number;
  feeProportionalMillionths: number;
  cltvExpiryDelta: number;
}

export interface Bolt11Invoice {
  // The invoice as nodes accept it: lower case, without a `lightning:` scheme.
  bolt11: string;
  network: Network;
  amount?: Msat;
  timestamp: number;
  expirySeconds: number;
  expiresAt: Date;
  paymentHash: PaymentHash;
  // From the `n` field, or recovered from the signature.
  payee: Pubkey;
  // Exactly one of the two is present.
  description?: UntrustedText;
  descriptionHash?: string;
  minFinalCltvExpiryDelta: number;
  // Feature bits as hex, most significant byte first (as CLN's `decode` shows them); '' when there are none.
  features: string;
  featureBits: number[];
  fallbacks: { address: string; type: AddressType | 'witness-unknown' }[];
  routeHints: RouteHintHop[][];
  metadata?: string;
}

const TIMESTAMP_WORDS = 7;
const SIGNATURE_WORDS = 104;
const DEFAULT_EXPIRY = 3600;
const DEFAULT_MIN_FINAL_CLTV = 18;

// Tags by their bech32 character.
const TAG = { p: 1, r: 3, '9': 5, x: 6, f: 9, d: 13, s: 16, n: 19, h: 23, c: 24, m: 27 } as const;

// Even feature bits we understand in an invoice (BOLT 9 rows with context `9`, plus the ASSUMED var_onion_optin and
// payment_secret, which every invoice sets, plus option_blake2b, which chain.ts checks). An unknown even bit means
// the payee requires something we cannot do, so the invoice is refused (BOLT11 "MUST fail the payment").
const KNOWN_EVEN_BITS = new Set([8, 14, 16, 24, 36, 48, 512]);
// Feature dependencies relevant to invoices (BOLT 9): basic_mpp needs payment_secret.
const DEPENDENCIES: [number, number][] = [[16, 14]];

const malformed = (message: string) => new DecodeError('malformed', message);

function fixedBytes(data: number[], what: string): Uint8Array {
  const bytes = wordsToBytes(data);
  if (!bytes) throw malformed(`The invoice's ${what} is malformed.`);
  return bytes;
}

// `x`, `c` and `9` must not start with a zero word (BOLT11 "SHOULD treat the invoice as invalid"; CLN refuses them).
function minimal(data: number[], what: string): void {
  if (data[0] === 0) throw new DecodeError('not_minimal', `The invoice's ${what} is not minimally encoded.`);
}

const hasBit = (bits: bigint, bit: number) => ((bits >> BigInt(bit)) & 1n) === 1n;

function readRouteHint(data: number[]): RouteHintHop[] {
  const bytes = fixedBytes(data, 'routing hint');
  const HOP = 51; // pubkey 33, short channel id 8, fee base 4, fee rate 4, CLTV delta 2
  if (bytes.length === 0 || bytes.length % HOP !== 0) throw malformed("The invoice's routing hint is malformed.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hops: RouteHintHop[] = [];
  for (let at = 0; at < bytes.length; at += HOP) {
    const scid = view.getBigUint64(at + 33);
    // Checked as a point on the curve, like the payee's key.
    const pubkey = readPubkey(bytes.subarray(at, at + 33));
    if (!pubkey) throw malformed("The invoice's routing hint has an invalid node key.");
    hops.push({
      pubkey,
      shortChannelId: `${scid >> 40n}x${(scid >> 16n) & 0xffffffn}x${scid & 0xffffn}`,
      feeBaseMsat: view.getUint32(at + 41),
      feeProportionalMillionths: view.getUint32(at + 45),
      cltvExpiryDelta: view.getUint16(at + 49),
    });
  }
  return hops;
}

function readPubkey(bytes: Uint8Array): Pubkey | undefined {
  try {
    Point.fromBytes(bytes);
    return parsePubkey(bytesToHex(bytes));
  } catch {
    return undefined;
  }
}

// Decodes and checks a BOLT11 invoice. Throws DecodeError. Does not check expiry (a caller decides what an expired
// invoice means) nor the chain (checkInvoiceChain).
export function decodeBolt11(input: string): Bolt11Invoice {
  const text = input.trim().replace(/^lightning:/i, '');
  // BIP173: all lower or all upper case.
  if (text !== text.toLowerCase() && text !== text.toUpperCase())
    throw malformed('The invoice mixes upper and lower case.');
  const bolt11 = text.toLowerCase();
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(bolt11 as `${string}1${string}`, false);
  } catch {
    throw malformed('Not a BOLT11 invoice.');
  }
  if (!decoded.prefix.startsWith('ln')) throw malformed('Not a BOLT11 invoice.');
  const hrp = decoded.prefix.slice(2);
  const prefix = BOLT11_PREFIXES.find(([p]) => hrp.startsWith(p));
  if (!prefix) throw new DecodeError('unknown_prefix', 'The invoice is for an unknown currency.');
  const [currency, network] = prefix;
  let amount: Msat | undefined;
  try {
    amount = readAmount(hrp.slice(currency.length));
  } catch {
    throw new DecodeError('invalid_amount', 'The invoice amount is not valid.');
  }

  const words = decoded.words;
  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) throw malformed('The invoice is too short.');
  const timestamp = wordsToNumber(words.slice(0, TIMESTAMP_WORDS));
  const signed = words.slice(0, words.length - SIGNATURE_WORDS);
  const fields = signed.slice(TIMESTAMP_WORDS);

  let paymentHash: PaymentHash | undefined;
  let hasSecret = false;
  let description: UntrustedText | undefined;
  let descriptionHash: string | undefined;
  let payeeField: Pubkey | undefined;
  let expirySeconds: number | undefined;
  let minFinalCltv: number | undefined;
  let featureWords: number[] | undefined;
  let metadata: string | undefined;
  const fallbacks: Bolt11Invoice['fallbacks'] = [];
  const routeHints: RouteHintHop[][] = [];

  for (let i = 0; i < fields.length;) {
    if (i + 3 > fields.length) throw malformed('The invoice has a truncated field.');
    const tag = fields[i] ?? 0;
    const length = (fields[i + 1] ?? 0) * 32 + (fields[i + 2] ?? 0);
    const data = fields.slice(i + 3, i + 3 + length);
    if (data.length !== length) throw malformed('The invoice has a truncated field.');
    i += 3 + length;
    // Fixed-length fields of the wrong length are skipped: the BOLT11 test vector "fields which must be ignored" and
    // CLN do so, although the requirement text says "MUST fail". Later copies of a field are skipped too (the first
    // one is the preferred one).
    switch (tag) {
      case TAG.p:
        if (length === 52 && paymentHash === undefined) {
          paymentHash = parsePaymentHash(bytesToHex(fixedBytes(data, 'payment hash')));
        }
        break;
      case TAG.s:
        if (length === 52 && !hasSecret) {
          fixedBytes(data, 'payment secret');
          hasSecret = true;
        }
        break;
      case TAG.d:
        if (description === undefined) {
          try {
            const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(fixedBytes(data, 'description'));
            description = untrustedText(utf8);
          } catch {
            throw malformed("The invoice's description is not valid UTF-8.");
          }
        }
        break;
      case TAG.h:
        if (length === 52 && descriptionHash === undefined) {
          descriptionHash = bytesToHex(fixedBytes(data, 'description hash'));
        }
        break;
      case TAG.n:
        if (length === 53 && payeeField === undefined) {
          payeeField = readPubkey(fixedBytes(data, 'payee'));
          if (!payeeField) throw malformed("The invoice's payee is not a valid public key.");
        }
        break;
      case TAG.x:
        if (expirySeconds === undefined) {
          minimal(data, 'expiry');
          // More than 7 words (35 bits) cannot be within MAX_EXPIRY.
          expirySeconds = data.length > TIMESTAMP_WORDS ? Infinity : wordsToNumber(data);
          if (expirySeconds > MAX_EXPIRY) throw malformed('The invoice expiry is too long.');
        }
        break;
      case TAG.c:
        if (minFinalCltv === undefined) {
          minimal(data, 'final CLTV delta');
          minFinalCltv = data.length > TIMESTAMP_WORDS ? Infinity : wordsToNumber(data);
          if (minFinalCltv > 0xffffffff) throw malformed("The invoice's final CLTV delta is too large.");
        }
        break;
      case TAG['9']:
        if (featureWords === undefined) {
          minimal(data, 'feature field');
          featureWords = data;
        }
        break;
      case TAG.f: {
        // Unknown versions and programs that are not valid are skipped (BOLT11 "MUST skip").
        const [version, ...rest] = data;
        const program = version === undefined ? undefined : wordsToBytes(rest);
        const fallback = program && version !== undefined ? fallbackAddress(version, program, network) : undefined;
        if (fallback) fallbacks.push(fallback);
        break;
      }
      case TAG.r:
        routeHints.push(readRouteHint(data));
        break;
      case TAG.m:
        if (metadata === undefined) metadata = bytesToHex(fixedBytes(data, 'metadata'));
        break;
      default:
        break;
    }
  }

  if (!paymentHash) throw new DecodeError('missing_field', 'The invoice has no payment hash.');
  if (!hasSecret) throw new DecodeError('missing_field', 'The invoice has no payment secret.');
  if (description === undefined && descriptionHash === undefined) {
    throw new DecodeError('missing_field', 'The invoice has no description.');
  }
  if (description !== undefined && descriptionHash !== undefined) {
    throw malformed('The invoice has both a description and a description hash.');
  }

  const words9 = featureWords ?? [];
  const bits = wordsToBigInt(words9);
  const featureBits: number[] = [];
  for (let bit = 0; bit < words9.length * 5; bit++) if (hasBit(bits, bit)) featureBits.push(bit);
  for (const bit of featureBits) {
    if (bit % 2 === 0 && !KNOWN_EVEN_BITS.has(bit)) {
      throw new DecodeError('unknown_feature', `The invoice requires feature ${bit}, which is not supported.`);
    }
  }
  for (const [feature, needs] of DEPENDENCIES) {
    const set = (b: number) => hasBit(bits, b) || hasBit(bits, b + 1);
    if (set(feature) && !set(needs)) {
      throw new DecodeError('unknown_feature', `The invoice sets feature ${feature} without feature ${needs}.`);
    }
  }
  const featureBytes = Math.ceil((words9.length * 5) / 8);
  const features = featureBytes === 0 ? '' : bits.toString(16).padStart(featureBytes * 2, '0');

  // Signature: 64 bytes R || S and a recovery id, over SHA-256 of the HRP and the data words before it.
  const signature = wordsToBytesPadded(words.slice(words.length - SIGNATURE_WORDS));
  const recovery = new DataView(signature.buffer).getUint8(64);
  if (recovery > 3) throw new DecodeError('invalid_signature', 'The invoice signature is not valid.');
  const message = sha256(Uint8Array.of(...new TextEncoder().encode(decoded.prefix), ...wordsToBytesPadded(signed)));
  let payee: Pubkey | undefined;
  try {
    if (payeeField) {
      // With an `n` field the signature must verify against it and be low-S.
      const compact = signature.subarray(0, 64);
      if (verify(compact, message, hexToBytes(payeeField), { prehash: false, lowS: true })) {
        payee = payeeField;
      }
    } else {
      // Without one the key is recovered, and high-S signatures are accepted.
      const recovered = Uint8Array.of(recovery, ...signature.subarray(0, 64));
      payee = parsePubkey(bytesToHex(recoverPublicKey(recovered, message, { prehash: false })));
    }
  } catch {
    payee = undefined;
  }
  if (!payee) throw new DecodeError('invalid_signature', 'The invoice signature is not valid.');

  const expiry = expirySeconds ?? DEFAULT_EXPIRY;
  return {
    bolt11,
    network,
    ...(amount === undefined ? {} : { amount }),
    timestamp,
    expirySeconds: expiry,
    expiresAt: new Date((timestamp + expiry) * 1000),
    paymentHash,
    payee,
    ...(description === undefined ? {} : { description }),
    ...(descriptionHash === undefined ? {} : { descriptionHash }),
    minFinalCltvExpiryDelta: minFinalCltv ?? DEFAULT_MIN_FINAL_CLTV,
    features,
    featureBits,
    fallbacks,
    routeHints,
    ...(metadata === undefined ? {} : { metadata }),
  };
}
