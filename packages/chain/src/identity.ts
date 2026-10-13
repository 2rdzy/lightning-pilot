// Basic chain identity check: is this node on the chain of its profile? Genesis and network name are the same on
// both chains, so the check looks at the chain data after the fork, and never trusts a single signal:
//   1 network      the node's network is the profile's network
//   2 software     option_blake2b advertised on BLAKE2b, absent on Bitcoin
//   4 fork height  the tip is past the BLAKE2b activation height (below it: `waiting`, whatever the profile)
//   3 header       the tip block's header has the profile's format (checked after 4: before the fork both chains
//                  have Bitcoin headers)
//   5 sync         the node's backend is synced (otherwise `waiting`)
// Anything that cannot be told is `refused`, never "probably fine".
import {
  untrustedText,
  type Chain,
  type ChainIdentityState,
  type FailedCheck,
  type Network,
  type NodeFacts,
} from '@lightning-pilot/core';
import { HeaderError, parseBlockHeader } from './header.ts';
import { BLAKE2B_ACTIVATION_HEIGHT, FEATURE_BITS, hasAnyFeature, PROFILES } from './profile.ts';

const NETWORK_NAME_MAX = 32;

export interface IdentityInput {
  profile: Chain;
  network: Network;
  facts: Pick<NodeFacts, 'network' | 'networkRaw' | 'features' | 'blockHeight' | 'synced'>;
  tip: { height: number; raw: string };
  now?: Date;
}

export function checkChainIdentity(input: IdentityInput): ChainIdentityState {
  const profile = PROFILES[input.profile];
  const checkedAt = (input.now ?? new Date()).toISOString();
  const result = (state: ChainIdentityState['state'], failedCheck?: FailedCheck, detail?: string) => ({
    state,
    profile: input.profile,
    checkedAt,
    ...(failedCheck ? { failedCheck } : {}),
    ...(detail ? { detail } : {}),
  });

  if (!profile.networks.includes(input.network)) {
    return result('refused', 'network', `${profile.displayName} has no ${input.network} network`);
  }
  if (input.facts.network !== input.network) {
    // The network name comes from the node: the detail is stored, logged and shown, so it is cleaned and cut.
    const raw = untrustedText(input.facts.networkRaw, NETWORK_NAME_MAX);
    return result('refused', 'network', `node is on ${raw}, profile expects ${input.network}`);
  }

  let blake2bAware: boolean;
  try {
    blake2bAware = hasAnyFeature(input.facts.features, FEATURE_BITS.option_blake2b);
  } catch {
    return result('refused', 'software', 'node feature bits are not readable');
  }
  if (profile.blake2bFeature === 'required' && !blake2bAware) {
    return result('refused', 'software', 'node software does not advertise option_blake2b');
  }
  if (profile.blake2bFeature === 'refused' && blake2bAware) {
    return result('refused', 'software', 'node software advertises option_blake2b');
  }

  const activation = BLAKE2B_ACTIVATION_HEIGHT[input.network];
  if (activation !== null && input.facts.blockHeight < activation) {
    return result('waiting', 'fork_height', `height ${input.facts.blockHeight} is below ${activation}`);
  }
  // The tip header comes from a separate call: it proves the chain only if it is past the fork too. A node that
  // reports a height past the fork but serves a tip from before it is incoherent (or rolled back across the fork).
  if (activation !== null && input.tip.height < activation) {
    return result(
      'refused',
      'header',
      `tip block ${input.tip.height} is below ${activation}, but the node reports height ${input.facts.blockHeight}`,
    );
  }

  let header;
  try {
    header = parseBlockHeader(input.tip.raw);
  } catch (err) {
    // parseBlockHeader throws only HeaderError, whose messages are fixed text.
    return result('refused', 'header', `tip block ${input.tip.height}: ${(err as HeaderError).message}`);
  }
  if (header.versionTopBit !== profile.versionTopBit || header.headerBytes !== profile.headerBytes) {
    return result(
      'refused',
      'header',
      `tip block ${input.tip.height} has a ${header.headerBytes}-byte header, profile expects ${profile.headerBytes}`,
    );
  }

  if (!input.facts.synced) return result('waiting', 'sync', 'node backend is not synced');
  return result('confirmed');
}
