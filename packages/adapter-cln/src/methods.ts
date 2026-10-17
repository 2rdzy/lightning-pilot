// The method table: one row per port method, with the CLN commands it calls, the credential they need, the
// catalogue feature and the capabilities it provides. The rune restrictions are generated from it (rune.ts), the
// capability report is computed from it (status.ts), and the tests check that the adapter calls exactly these
// commands with exactly these credentials, and that the regtest runes allow exactly these commands.
import type { MethodTable } from '@lightning-pilot/core';

export const METHODS = [
  { port: 'node', method: 'checkRune', nodeMethods: ['checkrune'], credential: 'read', feature: 'A5' },
  {
    port: 'node',
    method: 'getInfo',
    nodeMethods: ['getinfo'],
    credential: 'read',
    feature: 'A1',
    capabilities: ['node.info'],
  },
  // checkrune is called with the view rune to learn what the spend rune allows (credential scopes §4), without using
  // the spend rune; `plugin list` finds the bookkeeper.
  {
    port: 'node',
    method: 'getStatus',
    nodeMethods: ['getinfo', 'checkrune', 'plugin'],
    credential: 'read',
    feature: 'A5',
  },
  {
    port: 'chain',
    method: 'getTipHeader',
    nodeMethods: ['getinfo', 'getrawblockbyheight'],
    credential: 'read',
    feature: 'J11',
    capabilities: ['chain.identity'],
  },
  {
    port: 'chain',
    method: 'getHeaderAt',
    nodeMethods: ['getrawblockbyheight'],
    credential: 'read',
    feature: 'J11',
    capabilities: ['chain.identity'],
  },
  {
    port: 'chain',
    method: 'getFeeEstimates',
    nodeMethods: ['feerates'],
    credential: 'read',
    feature: 'F3',
    capabilities: ['fees.node_estimates'],
  },
  // getchaininfo is the chain backend's own view (headers, blocks, initial block download).
  {
    port: 'chain',
    method: 'isSynced',
    nodeMethods: ['getinfo', 'getchaininfo'],
    credential: 'read',
    feature: 'J11',
    capabilities: ['chain.identity'],
  },
  {
    port: 'balance',
    method: 'getBalances',
    nodeMethods: ['listfunds', 'listpeerchannels'],
    credential: 'read',
    feature: 'A2',
    capabilities: ['balances'],
  },
  {
    port: 'peer',
    method: 'listPeers',
    nodeMethods: ['listpeers', 'listnodes'],
    credential: 'read',
    feature: 'C1',
    capabilities: ['peers'],
  },
  {
    port: 'peer',
    method: 'connect',
    nodeMethods: ['connect'],
    credential: 'spend',
    feature: 'C1',
    capabilities: ['peers.manage'],
  },
  {
    port: 'peer',
    method: 'disconnect',
    nodeMethods: ['disconnect'],
    credential: 'spend',
    feature: 'C1',
    capabilities: ['peers.manage'],
  },
  {
    port: 'channel',
    method: 'listChannels',
    nodeMethods: ['listpeerchannels', 'listnodes'],
    credential: 'read',
    feature: 'C5',
    capabilities: ['channels.list'],
  },
  {
    port: 'channel',
    method: 'listClosedChannels',
    nodeMethods: ['listclosedchannels'],
    credential: 'read',
    feature: 'C5',
    capabilities: ['channels.closed'],
  },
  {
    port: 'channel',
    method: 'listHtlcs',
    nodeMethods: ['listhtlcs'],
    credential: 'read',
    feature: 'C7',
    capabilities: ['htlcs.list'],
  },
  {
    port: 'channel',
    method: 'openChannel',
    nodeMethods: ['fundchannel'],
    credential: 'spend',
    feature: 'C2',
    capabilities: ['channels.open'],
  },
  {
    port: 'channel',
    method: 'closeChannel',
    nodeMethods: ['close'],
    credential: 'spend',
    feature: 'C4',
    capabilities: ['channels.close', 'channels.close.force'],
  },
  {
    port: 'channel',
    method: 'setPolicy',
    nodeMethods: ['setchannel'],
    credential: 'spend',
    feature: 'C6',
    capabilities: ['channels.policy'],
  },
  // Receiving is allowed with the view credential: creating an invoice, offer or address cannot move funds out.
  {
    port: 'receive',
    method: 'createInvoice',
    nodeMethods: ['invoice'],
    credential: 'read',
    feature: 'D5',
    capabilities: ['receive.bolt11'],
  },
  { port: 'receive', method: 'listInvoices', nodeMethods: ['listinvoices'], credential: 'read', feature: 'D11' },
  { port: 'receive', method: 'getInvoice', nodeMethods: ['listinvoices'], credential: 'read', feature: 'D11' },
  {
    port: 'receive',
    method: 'newAddress',
    nodeMethods: ['newaddr'],
    credential: 'read',
    feature: 'B1',
    capabilities: ['receive.onchain'],
  },
  {
    port: 'receive',
    method: 'createOffer',
    nodeMethods: ['offer'],
    credential: 'read',
    feature: 'D7',
    capabilities: ['receive.offer'],
  },
  {
    port: 'receive',
    method: 'listOffers',
    nodeMethods: ['listoffers'],
    credential: 'read',
    feature: 'D7',
    capabilities: ['receive.offer'],
  },
  {
    port: 'receive',
    method: 'disableOffer',
    nodeMethods: ['disableoffer'],
    credential: 'read',
    feature: 'D7',
    capabilities: ['receive.offer'],
  },
  { port: 'pay', method: 'decode', nodeMethods: ['decode'], credential: 'read', feature: 'D2' },
  // getroutes needs our own node id as the source.
  {
    port: 'pay',
    method: 'previewRoute',
    nodeMethods: ['getinfo', 'getroutes'],
    credential: 'read',
    feature: 'D12',
    capabilities: ['pay.route_preview'],
  },
  {
    port: 'pay',
    method: 'fetchOfferInvoice',
    nodeMethods: ['fetchinvoice'],
    credential: 'read',
    feature: 'D7',
    capabilities: ['pay.bolt12'],
  },
  // listpays (implemented by the xpay plugin, so it outlives `pay`) gives one row per payment.
  { port: 'pay', method: 'listPayments', nodeMethods: ['listpays'], credential: 'read', feature: 'D11' },
  { port: 'pay', method: 'getPayment', nodeMethods: ['listsendpays'], credential: 'read', feature: 'D11' },
  { port: 'pay', method: 'listByLabel', nodeMethods: ['listsendpays'], credential: 'read', feature: 'D3' },
  // `xpay` and `xkeysend`, not `pay` and `keysend`: CLN deprecated those in v26.06 and removes them in v27.03.
  // xpay splits payments into parts by itself (multi-part payments).
  {
    port: 'pay',
    method: 'pay',
    nodeMethods: ['xpay'],
    credential: 'spend',
    feature: 'D1',
    capabilities: ['pay.bolt11', 'pay.bolt12', 'pay.mpp'],
  },
  {
    port: 'pay',
    method: 'keysend',
    nodeMethods: ['xkeysend'],
    credential: 'spend',
    feature: 'D3',
    capabilities: ['pay.keysend'],
  },
  // The bookkeeper gives amounts and kinds; without it the amount is worked out from the wallet's own coins
  // (listfunds, spent ones included) against each transaction's inputs and outputs.
  {
    port: 'onchain',
    method: 'listTransactions',
    nodeMethods: ['getinfo', 'listtransactions', 'bkpr-listaccountevents', 'listfunds'],
    credential: 'read',
    feature: 'B6',
  },
  {
    port: 'onchain',
    method: 'listUtxos',
    nodeMethods: ['listfunds'],
    credential: 'read',
    feature: 'B4',
    capabilities: ['onchain.utxos'],
  },
  // Whether a channel's local shutdown address is the wallet's own (spend policy §15 item 1, channel close cost).
  {
    port: 'onchain',
    method: 'ownsAddress',
    nodeMethods: ['listaddresses'],
    credential: 'read',
    feature: 'C4',
  },
  // txprepare/txsend instead of withdraw: the transaction id is known before anything is broadcast (spend policy §4).
  {
    port: 'onchain',
    method: 'prepare',
    nodeMethods: ['txprepare'],
    credential: 'spend',
    feature: 'B2',
    capabilities: ['onchain.send', 'onchain.send_max'],
  },
  {
    port: 'onchain',
    method: 'send',
    nodeMethods: ['txsend'],
    credential: 'spend',
    feature: 'B2',
    capabilities: ['onchain.send', 'onchain.send_max'],
  },
  {
    port: 'onchain',
    method: 'discard',
    nodeMethods: ['txdiscard'],
    credential: 'spend',
    feature: 'B2',
    capabilities: ['onchain.send', 'onchain.send_max'],
  },
  {
    port: 'onchain',
    method: 'unreserve',
    nodeMethods: ['unreserveinputs'],
    credential: 'spend',
    feature: 'B2',
    capabilities: ['onchain.send', 'onchain.send_max'],
  },
  {
    port: 'routing',
    method: 'listForwards',
    nodeMethods: ['listforwards'],
    credential: 'read',
    feature: 'E1',
    capabilities: ['routing.forwards', 'routing.forwards.failed'],
  },
  // `wait` on the invoices, sendpays and forwards indexes and `waitblockheight` for blocks; the changed rows are then
  // read with the list commands from the stored index.
  {
    port: 'events',
    method: 'subscribe',
    nodeMethods: ['getinfo', 'wait', 'waitblockheight', 'listinvoices', 'listsendpays', 'listforwards'],
    credential: 'read',
    feature: 'K1',
    capabilities: ['events.invoices', 'events.payments', 'events.forwards', 'events.blocks'],
  },
  { port: 'plugin', method: 'listPlugins', nodeMethods: ['plugin'], credential: 'read', feature: 'M3' },
] as const satisfies MethodTable;

export type ClnMethod = (typeof METHODS)[number]['nodeMethods'][number];

// Sub-clauses that narrow a method in the rune: `plugin` is allowed for `plugin list` only (credential scopes §2),
// and checkrune is asked with the same parameters.
export const METHOD_CLAUSES: Partial<Record<ClnMethod, { clause: string[]; params: Record<string, string> }>> = {
  plugin: { clause: ['method/plugin', 'pnamesubcommand=list'], params: { subcommand: 'list' } },
};
