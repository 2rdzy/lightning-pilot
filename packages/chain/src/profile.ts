// The chain-profile file: every chain-specific constant in one place, each with its source. Bump
// CHAIN_PROFILE_VERSION when a value changes, so logs and support requests show which rules were in force.
import type { Chain, Implementation, Network } from '@lightning-pilot/core';

export const CHAIN_PROFILE_VERSION = 2;

export interface ChainProfile {
  chain: Chain;
  displayName: string;
  coin: string;
  networks: readonly Network[];
  // Block header of a post-fork block: size in bytes, and whether the top bit of `version` is set.
  headerBytes: number;
  versionTopBit: boolean;
  // Node software must (blake2b) or must not (bitcoin) advertise option_blake2b.
  blake2bFeature: 'required' | 'refused';
  // BOLT11 feature bit 512 in invoices: required on BLAKE2b, refused on Bitcoin (checked by the full decoder).
  invoiceBit512: 'required' | 'refused';
  defaults: { explorer: string; price: string | null };
}

export const PROFILES: Record<Chain, ChainProfile> = {
  blake2b: {
    chain: 'blake2b',
    displayName: 'Bitcoin BLAKE2b',
    coin: 'XBT',
    // No signet: signet has no BLAKE2b chain.
    networks: ['mainnet', 'testnet4', 'regtest'],
    // 164-byte header with version 0x80000000 set: CLN fork lightningd/chaintopology.c, LND fork docs/blake2b.md;
    // seen on regtest as version 0xa0000000 (CLN fork, Knots) and 0xb0000000 (Lightning Fork).
    headerBytes: 164,
    versionTopBit: true,
    blake2bFeature: 'required',
    invoiceBit512: 'required',
    defaults: { explorer: 'https://mempool.kilombino.com', price: 'https://xbt.live/api/v1/prices' },
  },
  bitcoin: {
    chain: 'bitcoin',
    displayName: 'Bitcoin',
    coin: 'BTC',
    networks: ['mainnet', 'testnet4', 'signet', 'regtest'],
    // 80-byte header; nVersion is a signed 32-bit integer, so the top bit would make it negative, and Bitcoin Core
    // rejects any version below 4 (primitives/block.h, validation.cpp "bad-version").
    headerBytes: 80,
    versionTopBit: false,
    blake2bFeature: 'refused',
    invoiceBit512: 'refused',
    defaults: { explorer: 'https://mempool.space', price: null },
  },
};

// BLAKE2b activation height per network. Below it both chains share their history, so a node of either profile is
// only `waiting`. `null`: the network has no BLAKE2b chain and the height check is skipped.
// mainnet: CLN fork bitcoin/chainparams.c:32; testnet4: bitcoin/chainparams.c:157 (changed between Knots release
// candidates); regtest: tools/regtest starts Knots with testactivationheight=blake2b@1.
export const BLAKE2B_ACTIVATION_HEIGHT: Record<Network, number | null> = {
  mainnet: 961_640,
  testnet4: 150_308,
  signet: null,
  regtest: 1,
};

// Feature bits by name (BOLT 9 numbering; even = required, odd = optional).
export const FEATURE_BITS = {
  option_blake2b: [512, 513],
  option_unified_sigs: [514, 515],
} as const;

// The fork-version table: the node software versions tested for each chain profile and implementation. It is
// information, not a rule: other versions may work, and the identity check never refuses a node for its version
// (the five checks look at what the node does, not what it calls itself). Sources: CLN, the pins of
// tools/regtest/versions.json (the contract tests; a test keeps the two in step); LND, the /blake2bInfra environment
// (docs vault blake2bInfra/README.md, versions of 2026-10-12), until tools/regtest runs LND in release 0.2.
export interface TestedVersions {
  cln: string;
  lnd: string;
}

export const FORK_VERSIONS: Record<Chain, TestedVersions> = {
  // CLN fork (privkeyio, branch blake2b-unified) and Lightning Fork (paulscode/lightning-fork).
  blake2b: { cln: 'v26.06.9-blake2b.7', lnd: '0.21.4-beta-blake2b.18' },
  // Stock Core Lightning and LND.
  bitcoin: { cln: 'v26.06.9', lnd: '0.21.4-beta' },
};

// Whether a node runs a version the contract tests cover. CLN reports `v26.06.9-blake2b.7`; LND reports
// `0.21.4-beta commit=` or `0.21.4-beta-blake2b.18 commit=` (seen 2026-10-13), so only its first word is compared.
export function versionTested(chain: Chain, implementation: Implementation, version: string): boolean {
  const reported = implementation === 'lnd' ? version.replace(/ .*$/s, '') : version;
  return FORK_VERSIONS[chain][implementation] === reported;
}

// Feature bits as hex, most significant byte first (as CLN reports them). Tested on the string, never with 32-bit
// shifts, because the bits of interest are above 500.
export function hasFeature(hex: string, bit: number): boolean {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('feature bits are not hex');
  const bytes = hex.length / 2;
  const fromEnd = Math.floor(bit / 8);
  if (fromEnd >= bytes) return false;
  const start = (bytes - 1 - fromEnd) * 2;
  const byte = parseInt(hex.slice(start, start + 2), 16);
  return ((byte >> (bit % 8)) & 1) === 1;
}

export const hasAnyFeature = (hex: string, bits: readonly number[]): boolean => bits.some((b) => hasFeature(hex, b));
