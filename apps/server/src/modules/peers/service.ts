// Read side of peers: the node's peers with their addresses, features and channel counts. Connecting and
// disconnecting use the spend credential and live in the spend module.
import type { Peer } from '@lightning-pilot/core';
import type { NodesService } from '../nodes/index.ts';

export const peerJson = (p: Peer) => ({
  pubkey: p.pubkey,
  ...(p.alias === undefined ? {} : { alias: p.alias }),
  connected: p.connected,
  addresses: p.addresses,
  ...(p.features === undefined ? {} : { features: p.features }),
  numChannels: p.numChannels,
});

export class PeersService {
  readonly #nodes: NodesService;
  constructor(nodes: NodesService) {
    this.#nodes = nodes;
  }

  // The port returns the whole list (nodes do not page peers), so neither does the route.
  async list(nodeId: string) {
    const { adapter } = await this.#nodes.readAdapter(nodeId, 'peer', 'listPeers');
    return { items: (await adapter.peer.listPeers()).map(peerJson) };
  }
}
