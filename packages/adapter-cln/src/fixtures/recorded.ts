// Test helpers: a transport that plays recorded clnrest replies by command, and an adapter built on it.
import { AdapterError, parseJsonLossless } from '@lightning-pilot/core';
import { createClnAdapter, type ClnAdapterOptions } from '../adapter.ts';
import type { Transport } from '../context.ts';

export const ID = '024470f8943559c516abe722f8919fa81fec56ede15eb46ef557b0a0b15872a399';
export const PEER = '02dfd7e1d877aeedba89111d3987401fb9076195f358ca81b7fbedb550f9e1ebc1';
export const TXID = 'ab'.repeat(32);
export const HASH = 'cd'.repeat(32);
export const CHANNEL_ID = 'a5cc11428d45e1f07e67928483bab0f9d2695f350c0ce0d2c1b2a5547dcb7608';

export type Reply = unknown | ((params: Record<string, unknown>) => unknown);
export interface RecordedCall {
  command: string;
  params: Record<string, unknown>;
  rune: string;
  timeoutMs: number;
}

// Plays replies by command; a reply that is an Error (or a function returning or throwing one) is thrown. A string
// is parsed losslessly, as the client does.
export function recorded(replies: Record<string, Reply>) {
  const calls: RecordedCall[] = [];
  const transport: Transport = {
    call: async (command, params, options) => {
      calls.push({ command, params, rune: options.rune, timeoutMs: options.timeoutMs });
      const reply = replies[command];
      const value = typeof reply === 'function' ? (reply as (p: Record<string, unknown>) => unknown)(params) : reply;
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`no recorded reply for ${command}`);
      return typeof value === 'string' ? parseJsonLossless(value) : value;
    },
  };
  return { transport, calls };
}

// spendRune null: a node added without a spend credential.
export function adapter(
  replies: Record<string, Reply>,
  spendRune: string | null = 'SPEND',
  extra: Partial<ClnAdapterOptions> = {},
) {
  const r = recorded(replies);
  return {
    ...r,
    adapter: createClnAdapter({
      url: 'https://localhost:1',
      caCertificate: '',
      serverName: 'localhost',
      viewRune: 'VIEW',
      ...(spendRune === null ? {} : { spendRune }),
      transport: r.transport,
      ...extra,
    }),
  };
}

export const getinfo = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: ID,
    alias: 'blake2b-cln-a',
    color: '024470',
    version: 'v26.06.9-blake2b.7',
    network: 'regtest',
    blockheight: 126,
    num_peers: 2,
    num_active_channels: 2,
    num_pending_channels: 0,
    num_inactive_channels: 0,
    our_features: { init: '0200' },
    ...extra,
  });

export const nodeError = (nodeCode: number, detail = 'Failed') =>
  new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode, detail });

// A channel as listpeerchannels returns it (blake2b regtest, CLN fork v26.06.9-blake2b.7).
export const peerChannel = (extra: Record<string, unknown> = {}) => ({
  peer_id: PEER,
  peer_connected: true,
  state: 'CHANNELD_NORMAL',
  channel_id: CHANNEL_ID,
  short_channel_id: '118x1x0',
  funding_txid: TXID,
  funding_outnum: 0,
  opener: 'local',
  private: false,
  channel_type: { bits: [12, 22, 514], names: ['static_remotekey/even', 'anchors/even', 'unified_sigs/even'] },
  updates: {
    local: {
      htlc_minimum_msat: 0n,
      htlc_maximum_msat: 1980000000n,
      cltv_expiry_delta: 6,
      fee_base_msat: 1n,
      fee_proportional_millionths: 10,
    },
  },
  to_us_msat: 997780948n,
  total_msat: 2000000000n,
  spendable_msat: 973474948n,
  receivable_msat: 982219052n,
  our_reserve_msat: 20000000n,
  their_reserve_msat: 20000000n,
  in_payments_fulfilled: 16,
  in_fulfilled_msat: 106000000n,
  out_payments_fulfilled: 57,
  out_fulfilled_msat: 108219052n,
  ...extra,
});
