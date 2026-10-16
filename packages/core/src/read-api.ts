// Read API contract (WP14b): node details, fee estimates, channels, peers, payment and invoice history, on-chain
// transactions and coins, and new receive addresses. Lists keep the node's own order and page with an opaque cursor.
// Preimages are never part of these replies: the owner gets a payment's preimage once, when it is made.
import { z } from 'zod';
import { NodeAccessLevel, NodeInfoResponse } from './api.ts';
import {
  CAPABILITIES,
  CHANNEL_STATE_GROUPS,
  CLOSE_CAUSES,
  Chain,
  NEW_ADDRESS_TYPES,
  Network,
  ONCHAIN_TX_KINDS,
  PAGE_LIMIT_MAX,
} from './domain.ts';
import {
  ChannelIdSchema,
  FundingOutpointSchema,
  PaymentHashSchema,
  PubkeySchema,
  ShortChannelIdSchema,
  TxidSchema,
} from './ids.ts';
import { MsatString } from './money.ts';
import { UntrustedTextSchema } from './text.ts';

const SatPerVbyteString = z
  .string()
  .regex(/^[0-9]+(\.[0-9]+)?$/)
  .meta({ description: 'Fee rate in sat/vB, as a decimal string' });
const Hex = z.string().regex(/^([0-9a-f]{2})*$/);

// Query of every paged list. The cursor is opaque (a position in the node's own list); limit 1 to 200, default 50.
export const PageQuery = z.strictObject({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

const page = <T extends z.ZodType>(item: T, id: string) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().optional() }).meta({ id });
const list = <T extends z.ZodType>(item: T, id: string) => z.strictObject({ items: z.array(item) }).meta({ id });

// A channel is named by its short channel id, its channel id, or its funding outpoint while it has neither.
export const ChannelRef = z.union([ShortChannelIdSchema, ChannelIdSchema, FundingOutpointSchema]);
export const ChannelParam = z.strictObject({ nodeId: z.uuid(), channel: ChannelRef });
export const PaymentHashParam = z.strictObject({ nodeId: z.uuid(), paymentHash: PaymentHashSchema });

export const NodeDetailsResponse = NodeInfoResponse.extend({
  features: Hex,
  // Announced addresses only, as host:port; empty when the node announces none.
  addresses: z.array(z.string().max(300)),
  accessLevel: NodeAccessLevel,
  // What the stored credentials allow, from their last admission or verification (no node call).
  capabilities: z.array(z.enum(CAPABILITIES)),
}).meta({ id: 'NodeDetails' });

export const FeeEstimatesResponse = z
  .strictObject({
    source: z.enum(['node', 'explorer']),
    at: z.iso.datetime(),
    rates: z.strictObject({
      fastest: SatPerVbyteString,
      halfHour: SatPerVbyteString,
      hour: SatPerVbyteString,
      economy: SatPerVbyteString,
      minimum: SatPerVbyteString,
    }),
    node: z
      .strictObject({
        opening: SatPerVbyteString.optional(),
        mutualClose: SatPerVbyteString.optional(),
        unilateralClose: SatPerVbyteString.optional(),
      })
      .optional(),
  })
  .meta({ id: 'FeeEstimates' });

const PeerRef = z.strictObject({ pubkey: PubkeySchema, alias: UntrustedTextSchema.optional() });

export const ChannelResponse = z
  .strictObject({
    id: ChannelIdSchema,
    shortChannelId: ShortChannelIdSchema.optional(),
    peer: PeerRef,
    state: z.strictObject({
      group: z.enum(CHANNEL_STATE_GROUPS),
      native: z.string().max(100),
      nativeLabel: z.string().max(100),
    }),
    opener: z.enum(['local', 'remote']),
    private: z.boolean(),
    capacity: MsatString,
    local: MsatString,
    remote: MsatString,
    spendable: MsatString,
    receivable: MsatString,
    reserves: z.strictObject({ ours: MsatString, theirs: MsatString }),
    fundingOutpoint: FundingOutpointSchema,
    policy: z
      .strictObject({
        baseFeeMsat: MsatString,
        feePpm: z.int().nonnegative(),
        minHtlcMsat: MsatString,
        maxHtlcMsat: MsatString,
        cltvDelta: z.int().nonnegative(),
      })
      .optional(),
    channelType: z.array(z.string().max(100)),
    // BLAKE2b only: a channel without unified signatures can be replayed on the other chain. Always false on Bitcoin.
    replayableOnOtherChain: z.boolean(),
    closeTo: z.string().max(200).optional(),
    stats: z.strictObject({
      inFulfilled: MsatString,
      outFulfilled: MsatString,
      inPayments: z.int().nonnegative(),
      outPayments: z.int().nonnegative(),
    }),
  })
  .meta({ id: 'Channel' });
export const ChannelPage = page(ChannelResponse, 'ChannelPage');

export const ClosedChannelResponse = z
  .strictObject({
    id: ChannelIdSchema,
    shortChannelId: ShortChannelIdSchema.optional(),
    peer: PeerRef.optional(),
    capacity: MsatString,
    finalLocal: MsatString,
    closeCause: z.enum(CLOSE_CAUSES),
    closeCauseRaw: z.string().max(100),
    fundingOutpoint: FundingOutpointSchema,
    closingTxid: TxidSchema.optional(),
    closedAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'ClosedChannel' });
export const ClosedChannelPage = page(ClosedChannelResponse, 'ClosedChannelPage');

export const PeerResponse = z
  .strictObject({
    pubkey: PubkeySchema,
    alias: UntrustedTextSchema.optional(),
    connected: z.boolean(),
    addresses: z.array(z.string().max(300)),
    features: Hex.optional(),
    numChannels: z.int().nonnegative(),
  })
  .meta({ id: 'Peer' });
export const PeerList = list(PeerResponse, 'PeerList');

export const PaymentRecordResponse = z
  .strictObject({
    paymentHash: PaymentHashSchema,
    status: z.enum(['pending', 'succeeded', 'failed']),
    destination: PubkeySchema.optional(),
    amount: MsatString.optional(),
    amountSent: MsatString.optional(),
    fee: MsatString.optional(),
    createdAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    label: z.string().max(200).optional(),
    parts: z.int().positive().optional(),
  })
  .meta({ id: 'PaymentRecord' });
export const PaymentPage = page(PaymentRecordResponse, 'PaymentPage');

export const InvoiceRecordResponse = z
  .strictObject({
    paymentHash: PaymentHashSchema,
    bolt11: z.string(),
    amount: MsatString.optional(),
    amountReceived: MsatString.optional(),
    description: UntrustedTextSchema,
    label: z.string().max(200),
    status: z.enum(['unpaid', 'paid', 'expired']),
    createdAt: z.iso.datetime().optional(),
    expiresAt: z.iso.datetime(),
    paidAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'InvoiceRecord' });
export const InvoicePage = page(InvoiceRecordResponse, 'InvoicePage');

export const OnchainTxResponse = z
  .strictObject({
    txid: TxidSchema,
    amount: z.strictObject({ direction: z.enum(['in', 'out']), value: MsatString }).optional(),
    fee: MsatString.optional(),
    blockHeight: z.int().nonnegative().optional(),
    confirmations: z.int().nonnegative(),
    label: z.string().max(200).optional(),
    kind: z.enum(ONCHAIN_TX_KINDS),
  })
  .meta({ id: 'OnchainTx' });
export const OnchainTxPage = page(OnchainTxResponse, 'OnchainTxPage');

export const UtxoResponse = z
  .strictObject({
    outpoint: FundingOutpointSchema,
    amount: MsatString,
    address: z.string().max(200).optional(),
    status: z.enum(['unconfirmed', 'confirmed', 'spent', 'immature', 'unknown']),
    reserved: z.boolean(),
    blockHeight: z.int().nonnegative().optional(),
  })
  .meta({ id: 'Utxo' });
export const UtxoList = list(UtxoResponse, 'UtxoList');

export const NewAddressRequest = z
  .strictObject({ type: z.enum(NEW_ADDRESS_TYPES).default('p2wpkh') })
  .meta({ id: 'NewAddressRequest' });
// The chain profile is part of the reply: addresses look the same on both chains, so the screen must say which
// chain an address receives on. Only handed out while the node's chain identity is confirmed.
export const NewAddressResponse = z
  .strictObject({
    address: z.string().max(200),
    type: z.enum(NEW_ADDRESS_TYPES),
    chain: Chain,
    network: Network,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'NewAddress' });
