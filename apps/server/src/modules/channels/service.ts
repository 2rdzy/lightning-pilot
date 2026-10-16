// Read side of channels: the node's open and closed channels and one channel's details, through the view-only
// adapter. Opening, closing and policy changes are spends and live in the spend module.
import {
  AppError,
  toMsatString,
  type Chain,
  type Channel,
  type ClosedChannel,
  type Page,
  type PageRequest,
} from '@lightning-pilot/core';
import type { NodesService } from '../nodes/index.ts';

// The detail route scans the node's channel list; CLN returns it whole, so this only bounds a pathological node.
const SCAN_PAGES = 50;
const SCAN_LIMIT = 200;

// A BLAKE2b channel opened without the unified-signature opt-in can be replayed on the other chain (its
// commitment signatures are valid there too). The adapter does not know the profile, so the server decides.
export const replayableOnOtherChain = (chain: Chain, channel: Channel): boolean =>
  chain === 'blake2b' && !channel.channelType.includes('unified_sigs/even');

export function channelJson(chain: Chain, c: Channel) {
  return {
    id: c.id,
    ...(c.shortChannelId === undefined ? {} : { shortChannelId: c.shortChannelId }),
    peer: { pubkey: c.peer.pubkey, ...(c.peer.alias === undefined ? {} : { alias: c.peer.alias }) },
    state: c.state,
    opener: c.opener,
    private: c.private,
    capacity: toMsatString(c.capacity),
    local: toMsatString(c.local),
    remote: toMsatString(c.remote),
    spendable: toMsatString(c.spendable),
    receivable: toMsatString(c.receivable),
    reserves: { ours: toMsatString(c.reserves.ours), theirs: toMsatString(c.reserves.theirs) },
    fundingOutpoint: c.fundingOutpoint,
    ...(c.policy === undefined
      ? {}
      : {
          policy: {
            baseFeeMsat: toMsatString(c.policy.baseFeeMsat),
            feePpm: c.policy.feePpm,
            minHtlcMsat: toMsatString(c.policy.minHtlcMsat),
            maxHtlcMsat: toMsatString(c.policy.maxHtlcMsat),
            cltvDelta: c.policy.cltvDelta,
          },
        }),
    channelType: c.channelType,
    replayableOnOtherChain: replayableOnOtherChain(chain, c),
    ...(c.closeTo === undefined ? {} : { closeTo: c.closeTo }),
    stats: {
      inFulfilled: toMsatString(c.stats.inFulfilled),
      outFulfilled: toMsatString(c.stats.outFulfilled),
      inPayments: c.stats.inPayments,
      outPayments: c.stats.outPayments,
    },
  };
}

export function closedChannelJson(c: ClosedChannel) {
  return {
    id: c.id,
    ...(c.shortChannelId === undefined ? {} : { shortChannelId: c.shortChannelId }),
    ...(c.peer === undefined
      ? {}
      : { peer: { pubkey: c.peer.pubkey, ...(c.peer.alias === undefined ? {} : { alias: c.peer.alias }) } }),
    capacity: toMsatString(c.capacity),
    finalLocal: toMsatString(c.finalLocal),
    closeCause: c.closeCause,
    closeCauseRaw: c.closeCauseRaw,
    fundingOutpoint: c.fundingOutpoint,
    ...(c.closingTxid === undefined ? {} : { closingTxid: c.closingTxid }),
    ...(c.closedAt === undefined ? {} : { closedAt: c.closedAt }),
  };
}

const pageOf = <T, U>(page: Page<T>, map: (item: T) => U) => ({
  items: page.items.map(map),
  ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
});

export class ChannelsService {
  readonly #nodes: NodesService;
  constructor(nodes: NodesService) {
    this.#nodes = nodes;
  }

  async list(nodeId: string, page: PageRequest) {
    const { row, adapter } = await this.#nodes.readAdapter(nodeId, 'channel', 'listChannels');
    return pageOf(await adapter.channel.listChannels(page), (c) => channelJson(row.chain as Chain, c));
  }

  async closed(nodeId: string, page: PageRequest) {
    const { adapter } = await this.#nodes.readAdapter(nodeId, 'channel', 'listClosedChannels');
    return pageOf(await adapter.channel.listClosedChannels(page), closedChannelJson);
  }

  // `ref` is a short channel id, a channel id or a funding outpoint (style guide: detail screens use the short
  // channel id, or the funding outpoint while a channel has none).
  async get(nodeId: string, ref: string) {
    const { row, adapter } = await this.#nodes.readAdapter(nodeId, 'channel', 'listChannels');
    let cursor: string | undefined;
    for (let i = 0; i < SCAN_PAGES; i++) {
      const page = await adapter.channel.listChannels({ limit: SCAN_LIMIT, ...(cursor ? { cursor } : {}) });
      const found = page.items.find((c) => c.shortChannelId === ref || c.id === ref || c.fundingOutpoint === ref);
      if (found) return channelJson(row.chain as Chain, found);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    throw new AppError('not_found', 'No such channel.');
  }
}
