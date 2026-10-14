// On-chain address validation per network: base58check P2PKH/P2SH, bech32 segwit v0 (BIP173) and bech32m v1+
// (BIP350). Both chain profiles use the same address formats; the prefixes come from Bitcoin Knots
// src/kernel/chainparams.cpp (`bech32_hrp`, `base58Prefixes`), which match the CLN fork's bitcoin/chainparams.c.
// testnet4 and signet share every prefix, and regtest shares the base58 versions with them, so an address alone
// cannot name its network: it is checked against the node's network instead.
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import type { Network } from '../domain.ts';
import { DecodeError } from './errors.ts';
import { bytesToWords, wordsToBytes } from './words.ts';

export const ADDRESS_TYPES = ['p2pkh', 'p2sh', 'p2wpkh', 'p2wsh', 'p2tr'] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

export interface OnchainAddress {
  // bech32 addresses in lower case; base58 addresses as given (they are case-sensitive).
  address: string;
  type: AddressType;
  network: Network;
  // The output script that pays this address (scriptPubKey), hex.
  script: string;
}

interface AddressParams {
  hrp: string;
  p2pkh: number;
  p2sh: number;
}

export const ADDRESS_PARAMS: Record<Network, AddressParams> = {
  mainnet: { hrp: 'bc', p2pkh: 0, p2sh: 5 },
  testnet4: { hrp: 'tb', p2pkh: 111, p2sh: 196 },
  signet: { hrp: 'tb', p2pkh: 111, p2sh: 196 },
  regtest: { hrp: 'bcrt', p2pkh: 111, p2sh: 196 },
};

const KNOWN_HRPS = new Set(Object.values(ADDRESS_PARAMS).map((p) => p.hrp));
const KNOWN_VERSIONS = new Set(Object.values(ADDRESS_PARAMS).flatMap((p) => [p.p2pkh, p.p2sh]));

const base58check = createBase58check(sha256);
const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

// The witness programs we send to. Other versions and lengths are valid addresses (BIP350 allows versions 1-16 with
// 2-40 byte programs) but nothing spends them today, so coins sent there may be lost or taken by anyone.
export function witnessType(version: number, length: number): AddressType | undefined {
  if (version === 0 && length === 20) return 'p2wpkh';
  if (version === 0 && length === 32) return 'p2wsh';
  if (version === 1 && length === 32) return 'p2tr';
  return undefined;
}

function decodeSegwit(text: string, network: Network): OnchainAddress {
  const lower = text.toLowerCase();
  let decoded: { prefix: string; words: number[] } | undefined;
  let isBech32m = false;
  try {
    decoded = bech32.decode(lower as `${string}1${string}`);
  } catch {
    try {
      decoded = bech32m.decode(lower as `${string}1${string}`);
      isBech32m = true;
    } catch {
      throw new DecodeError('malformed', 'Not a valid address.');
    }
  }
  if (text !== lower && text !== text.toUpperCase()) throw new DecodeError('malformed', 'Not a valid address.');
  // decodeAddress sends only known prefixes here.
  if (decoded.prefix !== ADDRESS_PARAMS[network].hrp) {
    throw new DecodeError('wrong_network', `This address is not for ${network}.`);
  }
  const [version, ...rest] = decoded.words;
  const program = rest.length > 0 ? wordsToBytes(rest) : undefined;
  // BIP350: version 0 uses bech32, versions 1-16 bech32m; programs are 2-40 bytes (20 or 32 for version 0).
  if (
    version === undefined ||
    version > 16 ||
    program === undefined ||
    program.length < 2 ||
    program.length > 40 ||
    (version === 0) === isBech32m ||
    (version === 0 && program.length !== 20 && program.length !== 32)
  ) {
    throw new DecodeError('malformed', 'Not a valid address.');
  }
  const type = witnessType(version, program.length);
  if (!type) throw new DecodeError('unsupported', 'This kind of address is not supported.');
  // OP_0 or OP_1..OP_16, then a push of the program.
  const script = [version === 0 ? 0 : 0x50 + version, program.length, ...program];
  return { address: lower, type, network, script: hex(script) };
}

function decodeBase58(text: string, network: Network): OnchainAddress {
  let bytes: Uint8Array;
  try {
    bytes = base58check.decode(text);
  } catch {
    throw new DecodeError('malformed', 'Not a valid address.');
  }
  const [version] = bytes;
  if (bytes.length !== 21 || version === undefined) throw new DecodeError('malformed', 'Not a valid address.');
  const params = ADDRESS_PARAMS[network];
  const hash = hex([...bytes.subarray(1)]);
  if (version === params.p2pkh) return { address: text, type: 'p2pkh', network, script: `76a914${hash}88ac` };
  if (version === params.p2sh) return { address: text, type: 'p2sh', network, script: `a914${hash}87` };
  if (KNOWN_VERSIONS.has(version)) throw new DecodeError('wrong_network', `This address is not for ${network}.`);
  throw new DecodeError('unknown_prefix', 'Unknown address prefix.');
}

const isBech32 = (lower: string): boolean =>
  [bech32, bech32m].some((coder) => {
    try {
      coder.decode(lower as `${string}1${string}`);
      return true;
    } catch {
      return false;
    }
  });

// Validates an on-chain address for the node's network. Throws DecodeError.
export function decodeAddress(input: string, network: Network): OnchainAddress {
  const text = input.trim();
  const lower = text.toLowerCase();
  const separator = lower.lastIndexOf('1');
  if (separator > 0 && KNOWN_HRPS.has(lower.slice(0, separator))) return decodeSegwit(text, network);
  // A valid bech32 string with another prefix (e.g. a Litecoin `ltc1...` address).
  if (isBech32(lower)) throw new DecodeError('unknown_prefix', 'Unknown address prefix.');
  return decodeBase58(text, network);
}

// Address of a BOLT11 fallback (`f` field): version 0-16 is a witness program, 17 a P2PKH hash, 18 a P2SH hash.
// Returns undefined for versions BOLT11 tells readers to skip, and for programs that are not valid.
export function fallbackAddress(
  version: number,
  program: Uint8Array,
  network: Network,
): { address: string; type: AddressType | 'witness-unknown' } | undefined {
  const params = ADDRESS_PARAMS[network];
  if (version === 17 || version === 18) {
    if (program.length !== 20) return undefined;
    const prefix = version === 17 ? params.p2pkh : params.p2sh;
    return { address: base58check.encode(Uint8Array.of(prefix, ...program)), type: version === 17 ? 'p2pkh' : 'p2sh' };
  }
  if (version > 16 || program.length < 2 || program.length > 40) return undefined;
  if (version === 0 && program.length !== 20 && program.length !== 32) return undefined;
  const coder = version === 0 ? bech32 : bech32m;
  // Long programs make addresses over bech32's 90-character limit only for unusual versions; allow them here.
  const address = coder.encode(params.hrp, [version, ...bytesToWords(program)], false);
  return { address, type: witnessType(version, program.length) ?? 'witness-unknown' };
}
