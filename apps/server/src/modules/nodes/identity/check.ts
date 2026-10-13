// Runs the five chain identity checks against a node (@lightning-pilot/chain checkChainIdentity): network, software,
// fork height, tip header, sync. A node that cannot answer is refused: "cannot tell" is never "probably fine".
import { checkChainIdentity } from '@lightning-pilot/chain';
import type { Chain, ChainIdentityState, NodeAdapter, NodeFacts, Network } from '@lightning-pilot/core';

export interface IdentityResult {
  facts: NodeFacts | undefined;
  identity: ChainIdentityState;
  error: unknown;
}

export async function runIdentityCheck(
  adapter: NodeAdapter,
  chain: Chain,
  network: Network,
  now: Date,
): Promise<IdentityResult> {
  let facts;
  let tip;
  try {
    facts = await adapter.node.getInfo();
    tip = await adapter.chain.getTipHeader();
  } catch (err) {
    return {
      facts: undefined,
      identity: { state: 'refused', profile: chain, checkedAt: now.toISOString(), failedCheck: 'unreachable' },
      error: err,
    };
  }
  return { facts, identity: checkChainIdentity({ profile: chain, network, facts, tip, now }), error: undefined };
}
