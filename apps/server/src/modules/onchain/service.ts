// On-chain reads: the wallet's transactions and coins, and the node's fee estimates. Sending is a spend and lives
// in the spend module; new receive addresses are the wallet module's.
import {
  toMsatString,
  untrustedText,
  type FeeEstimates,
  type OnchainTx,
  type PageRequest,
  type Utxo,
} from '@lightning-pilot/core';
import type { NodesService } from '../nodes/index.ts';

export const transactionJson = (t: OnchainTx) => ({
  txid: t.txid,
  ...(t.amount === undefined ? {} : { amount: { direction: t.amount.direction, value: toMsatString(t.amount.value) } }),
  ...(t.fee === undefined ? {} : { fee: toMsatString(t.fee) }),
  ...(t.blockHeight === undefined ? {} : { blockHeight: t.blockHeight }),
  confirmations: t.confirmations,
  ...(t.label === undefined ? {} : { label: untrustedText(t.label, 200) }),
  kind: t.kind,
});

export const utxoJson = (u: Utxo) => ({
  outpoint: u.outpoint,
  amount: toMsatString(u.amount),
  ...(u.address === undefined ? {} : { address: u.address }),
  status: u.status,
  reserved: u.reserved,
  ...(u.blockHeight === undefined ? {} : { blockHeight: u.blockHeight }),
});

// Node estimates only: the explorer cross-check needs a guarded fetcher, which no work package has built yet.
export const feesJson = (f: FeeEstimates) => ({
  source: f.source,
  at: f.at,
  rates: f.rates,
  ...(f.node === undefined ? {} : { node: f.node }),
});

export class OnchainService {
  readonly #nodes: NodesService;
  constructor(nodes: NodesService) {
    this.#nodes = nodes;
  }

  // Newest first (the port's order).
  async transactions(nodeId: string, page: PageRequest) {
    const { adapter } = await this.#nodes.readAdapter(nodeId, 'onchain', 'listTransactions');
    const result = await adapter.onchain.listTransactions(page);
    return {
      items: result.items.map(transactionJson),
      ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
    };
  }

  // The port returns every coin (nodes do not page them), so neither does the route.
  async utxos(nodeId: string) {
    const { adapter } = await this.#nodes.readAdapter(nodeId, 'onchain', 'listUtxos');
    return { items: (await adapter.onchain.listUtxos()).map(utxoJson) };
  }

  async fees(nodeId: string) {
    const { adapter } = await this.#nodes.readAdapter(nodeId, 'chain', 'getFeeEstimates');
    return feesJson(await adapter.chain.getFeeEstimates());
  }
}
