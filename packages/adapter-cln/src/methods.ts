// The method table: one row per port method, with the CLN commands it calls, the credential they need and the
// catalogue feature. The rune restrictions are generated from it (rune.ts), and a test checks that the adapter
// calls exactly these commands with exactly these credentials.
import type { MethodTable } from '@lightning-pilot/core';

export const METHODS = [
  { port: 'node', method: 'getInfo', nodeMethods: ['getinfo'], credential: 'read', feature: 'A1' },
  {
    port: 'chain',
    method: 'getTipHeader',
    nodeMethods: ['getinfo', 'getrawblockbyheight'],
    credential: 'read',
    feature: 'J11',
  },
  {
    port: 'balance',
    method: 'getBalances',
    nodeMethods: ['listfunds', 'listpeerchannels'],
    credential: 'read',
    feature: 'A2',
  },
  // Receiving is allowed with the view credential: creating an invoice cannot move funds out.
  { port: 'receive', method: 'createInvoice', nodeMethods: ['invoice'], credential: 'read', feature: 'D5' },
  { port: 'pay', method: 'getPayment', nodeMethods: ['listsendpays'], credential: 'read', feature: 'D11' },
  // `xpay`, not `pay`: CLN deprecated `pay` in v26.06 and removes it in v27.03.
  { port: 'pay', method: 'pay', nodeMethods: ['xpay'], credential: 'spend', feature: 'D1' },
] as const satisfies MethodTable;

export type ClnMethod = (typeof METHODS)[number]['nodeMethods'][number];
