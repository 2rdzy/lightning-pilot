// Schemas for the parts of CLN's replies the adapter uses (field names from CLN's doc/schemas, v26.06). A buggy or
// compromised node must not crash or mislead the server, so every field used is checked; fields we do not use are
// ignored (newer CLN versions add some). Amounts arrive as bigint from the lossless parser. Enumerations a newer
// node may extend (states, statuses, tags) are plain strings here and mapped to `unknown` by the adapter.
import { z } from 'zod';

const msat = z.bigint().nonnegative();
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const hex = z.string().regex(/^([0-9a-f]{2})*$/);
const pubkey = z.string().regex(/^0[23][0-9a-f]{64}$/);
const scid = z.string().regex(/^[0-9]{1,8}x[0-9]{1,8}x[0-9]{1,5}$/);
const u32 = z.int().nonnegative();
const index = z.int().nonnegative();
// Free text from the node or a peer; limited so a hostile node cannot make us hold megabytes per field.
const text = z.string().max(4096);

export const GetInfo = z.object({
  id: pubkey,
  alias: z.string().optional(),
  color: z.string().regex(/^[0-9a-f]{6}$/),
  version: z.string().max(200),
  network: z.string().max(50),
  blockheight: u32,
  num_peers: u32,
  num_active_channels: u32,
  num_pending_channels: u32,
  num_inactive_channels: u32,
  our_features: z.object({ init: hex }),
  // Announced addresses (`binding`, the local listen sockets, is deliberately not read).
  address: z
    .array(z.object({ type: z.string().max(20), address: z.string().max(300).optional(), port: u32 }))
    .max(64)
    .optional(),
  warning_bitcoind_sync: z.string().optional(),
  warning_lightningd_sync: z.string().optional(),
});

export const GetChainInfo = z.object({ headercount: u32, blockcount: u32, ibd: z.boolean() });

export const RawBlock = z.object({ blockhash: z.string().optional(), block: z.string().regex(/^([0-9a-f]{2})+$/) });

export const CheckRune = z.object({ valid: z.boolean() });

export const PluginList = z.object({
  plugins: z.array(z.object({ name: z.string().max(4096), active: z.boolean() })),
});

const feerates = z.object({
  min_acceptable: u32,
  floor: u32.optional(),
  estimates: z.array(z.object({ blockcount: u32, feerate: u32, smoothed_feerate: u32.optional() })).optional(),
  opening: u32.optional(),
  mutual_close: u32.optional(),
  unilateral_close: u32.optional(),
});
export const Feerates = z.object({ perkb: feerates });

export const ListFunds = z.object({
  outputs: z.array(
    z.object({
      txid: hex32,
      output: u32,
      amount_msat: msat,
      address: z.string().max(200).optional(),
      status: z.string(),
      reserved: z.boolean().optional(),
      blockheight: u32.optional(),
    }),
  ),
});

const policy = z.object({
  htlc_minimum_msat: msat,
  htlc_maximum_msat: msat,
  cltv_expiry_delta: u32,
  fee_base_msat: msat,
  fee_proportional_millionths: u32,
});

export const PeerChannel = z.object({
  peer_id: pubkey,
  peer_connected: z.boolean().optional(),
  state: z.string().max(100),
  channel_id: hex32.optional(),
  short_channel_id: scid.optional(),
  funding_txid: hex32.optional(),
  funding_outnum: u32.optional(),
  opener: z.string().max(20).optional(),
  private: z.boolean().optional(),
  channel_type: z.object({ names: z.array(z.string().max(100)) }).optional(),
  updates: z.object({ local: policy.optional() }).optional(),
  close_to_addr: z.string().max(200).optional(),
  to_us_msat: msat.optional(),
  total_msat: msat.optional(),
  spendable_msat: msat.optional(),
  receivable_msat: msat.optional(),
  our_reserve_msat: msat.optional(),
  their_reserve_msat: msat.optional(),
  in_payments_fulfilled: u32.optional(),
  in_fulfilled_msat: msat.optional(),
  out_payments_fulfilled: u32.optional(),
  out_fulfilled_msat: msat.optional(),
});
export type PeerChannel = z.infer<typeof PeerChannel>;
export const ListPeerChannels = z.object({ channels: z.array(PeerChannel) });

export const ClosedChannelRow = z.object({
  peer_id: pubkey.optional(),
  channel_id: hex32,
  short_channel_id: scid.optional(),
  funding_txid: hex32,
  funding_outnum: u32,
  total_msat: msat,
  final_to_us_msat: msat,
  close_cause: z.string().max(50),
});
export type ClosedChannelRow = z.infer<typeof ClosedChannelRow>;
export const ListClosedChannels = z.object({ closedchannels: z.array(ClosedChannelRow) });

export const ListHtlcs = z.object({
  htlcs: z.array(
    z.object({
      short_channel_id: scid,
      created_index: index,
      expiry: u32,
      amount_msat: msat,
      direction: z.enum(['in', 'out']),
      payment_hash: hex32,
      state: z.string().max(100),
    }),
  ),
});

export const ListPeers = z.object({
  peers: z.array(
    z.object({
      id: pubkey,
      connected: z.boolean(),
      num_channels: u32.optional(),
      netaddr: z.array(z.string().max(300)).optional(),
      features: hex.optional(),
    }),
  ),
});

export const ListNodes = z.object({
  nodes: z.array(z.object({ nodeid: pubkey, alias: z.string().optional() })),
});

export const InvoiceReply = z.object({
  bolt11: z.string(),
  payment_hash: hex32,
  expires_at: u32,
  created_index: index.optional(),
});

export const InvoiceRow = z.object({
  label: text,
  description: text.optional(),
  payment_hash: hex32,
  status: z.string().max(20),
  expires_at: u32,
  amount_msat: msat.optional(),
  bolt11: z.string().optional(),
  created_index: index,
  updated_index: index.optional(),
  amount_received_msat: msat.optional(),
  paid_at: u32.optional(),
  payment_preimage: hex32.optional(),
});
export type InvoiceRow = z.infer<typeof InvoiceRow>;
export const ListInvoices = z.object({ invoices: z.array(InvoiceRow) });

export const NewAddr = z.object({ bech32: z.string().max(200).optional(), p2tr: z.string().max(200).optional() });

export const OfferRow = z.object({
  offer_id: hex32,
  active: z.boolean(),
  single_use: z.boolean(),
  bolt12: z.string(),
  used: z.boolean(),
  description: text.optional(),
  label: text.optional(),
});
export type OfferRow = z.infer<typeof OfferRow>;
export const ListOffers = z.object({ offers: z.array(OfferRow) });

export const FetchInvoice = z.object({ invoice: z.string() });

export const Decode = z.object({
  type: z.string().max(100),
  valid: z.boolean(),
  amount_msat: msat.optional(),
  offer_amount_msat: msat.optional(),
  invoice_amount_msat: msat.optional(),
  payee: pubkey.optional(),
  invoice_node_id: pubkey.optional(),
  offer_issuer_id: pubkey.optional(),
  payment_hash: hex32.optional(),
  invoice_payment_hash: hex32.optional(),
  description: text.optional(),
  offer_description: text.optional(),
});

export const GetRoutes = z.object({
  probability_ppm: z.int().nonnegative(),
  routes: z.array(
    z.object({
      amount_msat: msat,
      path: z.array(z.object({ amount_msat: msat })),
    }),
  ),
});

export const PayRow = z.object({
  payment_hash: hex32,
  status: z.string().max(20),
  destination: pubkey.optional(),
  created_at: u32,
  completed_at: u32.optional(),
  label: text.optional(),
  created_index: index,
  updated_index: index.optional(),
  amount_msat: msat.optional(),
  amount_sent_msat: msat.optional(),
  preimage: hex32.optional(),
  number_of_parts: u32.optional(),
});
export type PayRow = z.infer<typeof PayRow>;
export const ListPays = z.object({ pays: z.array(PayRow) });

export const SendPayRow = z.object({
  payment_hash: hex32,
  status: z.string(),
  created_index: index.optional(),
  updated_index: index.optional(),
  destination: pubkey.optional(),
  created_at: u32.optional(),
  completed_at: u32.optional(),
  amount_msat: msat.optional(),
  amount_sent_msat: msat.optional(),
  payment_preimage: hex32.optional(),
  label: z.string().optional(),
});
export type SendPayRow = z.infer<typeof SendPayRow>;
export const ListSendPays = z.object({ payments: z.array(SendPayRow) });

export const XpayReply = z.object({
  payment_preimage: hex32,
  amount_msat: msat,
  amount_sent_msat: msat,
});

export const ListTransactions = z.object({
  transactions: z.array(
    z.object({
      hash: hex32,
      blockheight: u32,
      inputs: z.array(z.object({ txid: hex32, index: u32 })).optional(),
      outputs: z.array(z.object({ index: u32, amount_msat: msat })).optional(),
    }),
  ),
});

export const AccountEvents = z.object({
  events: z.array(
    z.object({
      account: z.string().max(100),
      type: z.string().max(20),
      tag: z.string().max(50),
      credit_msat: msat,
      debit_msat: msat,
      timestamp: u32,
      outpoint: z
        .string()
        .regex(/^[0-9a-f]{64}:[0-9]{1,10}$/)
        .optional(),
      txid: hex32.optional(),
      blockheight: u32.optional(),
    }),
  ),
});

export const TxPrepare = z.object({ psbt: z.string().max(4_000_000), txid: hex32 });
export const TxSend = z.object({ txid: hex32 });
// `listaddresses address=…`: the issued wallet address that matches, or none.
export const ListAddresses = z.object({ addresses: z.array(z.object({ keyidx: z.number().int() })).max(1000) });

export const FundChannel = z.object({ txid: hex32, outnum: u32, channel_id: hex32 });

export const Close = z.object({ type: z.string().max(20), txids: z.array(hex32).optional() });

export const Connect = z.object({ id: pubkey });

export const ForwardRow = z.object({
  created_index: index,
  updated_index: index.optional(),
  in_channel: scid,
  in_msat: msat,
  status: z.string().max(20),
  received_time: z.number().nonnegative(),
  out_channel: scid.optional(),
  out_msat: msat.optional(),
  fee_msat: msat.optional(),
  resolved_time: z.number().nonnegative().optional(),
  failcode: u32.optional(),
});
export type ForwardRow = z.infer<typeof ForwardRow>;
export const ListForwards = z.object({ forwards: z.array(ForwardRow) });

export const WaitReply = z.object({
  subsystem: z.string(),
  created: index.optional(),
  updated: index.optional(),
  deleted: index.optional(),
});

export const WaitBlockHeight = z.object({ blockheight: u32 });
