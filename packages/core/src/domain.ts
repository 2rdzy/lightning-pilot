// Domain types used between the adapters and the server. Amounts are Msat (bigint); the API layer turns them into
// decimal strings (api.ts).
import { z } from 'zod';
import type { ChannelId, FundingOutpoint, PaymentHash, Pubkey, ShortChannelId, Txid } from './ids.ts';
import type { Msat } from './money.ts';
import type { UntrustedText } from './text.ts';

// The two chain profiles: Bitcoin BLAKE2b and Bitcoin (SHA256d). Genesis and network names are the same on both, so
// the profile is chosen per node and enforced by the chain identity check.
export const CHAINS = ['blake2b', 'bitcoin'] as const;
export const Chain = z.enum(CHAINS);
export type Chain = z.infer<typeof Chain>;

export const NETWORKS = ['mainnet', 'testnet4', 'signet', 'regtest'] as const;
export const Network = z.enum(NETWORKS);
export type Network = z.infer<typeof Network>;

export const IMPLEMENTATIONS = ['cln', 'lnd'] as const;
export const Implementation = z.enum(IMPLEMENTATIONS);
export type Implementation = z.infer<typeof Implementation>;

export interface NodeRef {
  chain: Chain;
  network: Network;
  pubkey: Pubkey;
}

export const IDENTITY_STATES = ['confirmed', 'waiting', 'refused'] as const;
export type IdentityState = (typeof IDENTITY_STATES)[number];
// Which part of the chain identity check failed. `node`: the node at the stored address answers with another public
// key than the node that was added (rebuilt with a new key, or another machine answering for it); the chain checks
// alone would not notice, since they look at the chain, not at who answers.
export const FAILED_CHECKS = ['network', 'software', 'header', 'fork_height', 'sync', 'unreachable', 'node'] as const;
export type FailedCheck = (typeof FAILED_CHECKS)[number];

export interface ChainIdentityState {
  state: IdentityState;
  profile: Chain;
  checkedAt: string;
  failedCheck?: FailedCheck;
  detail?: string;
}

// What the node says about itself (NodeInfo without the chain identity, which the server adds).
export interface NodeFacts {
  pubkey: Pubkey;
  alias: UntrustedText;
  color: string;
  implementation: Implementation;
  version: string;
  // `unknown` when the node reports a network we do not know; the raw name is kept.
  network: Network | 'unknown';
  networkRaw: string;
  blockHeight: number;
  synced: boolean;
  numPeers: number;
  numActiveChannels: number;
  numPendingChannels: number;
  numInactiveChannels: number;
  // Node feature bits from the init message, hex, most significant byte first.
  features: string;
}

export interface Balances {
  onchain: { confirmed: Msat; unconfirmed: Msat; reserved: Msat };
  lightning: { local: Msat; spendable: Msat; remote: Msat; receivable: Msat };
  pendingClose: Msat;
}

export interface Invoice {
  paymentHash: PaymentHash;
  bolt11: string;
  amount?: Msat;
  amountReceived?: Msat;
  description: UntrustedText;
  label: string;
  status: 'unpaid' | 'paid' | 'expired';
  createdAt?: string;
  expiresAt: string;
  paidAt?: string;
  // Only once paid.
  preimage?: string;
}

export type PaymentStatus = 'pending' | 'succeeded' | 'failed';

export interface Payment {
  paymentHash: PaymentHash;
  status: PaymentStatus;
  destination?: Pubkey;
  amount?: Msat;
  amountSent?: Msat;
  // amountSent - amount, when both are known.
  fee?: Msat;
  createdAt?: string;
  completedAt?: string;
  preimage?: string;
  label?: string;
  // Number of parts (multi-part payments), when the node reports it.
  parts?: number;
}

export interface PayResult {
  paymentHash: PaymentHash;
  preimage: string;
  amount: Msat;
  amountSent: Msat;
  fee: Msat;
}

export const SPEND_STATES = ['reserved', 'sent', 'succeeded', 'failed', 'unknown'] as const;
export type SpendState = (typeof SPEND_STATES)[number];

// Lists are paginated. The cursor is opaque to the caller; adapters map it to the node's own index (CLN
// `created_index` + `start`/`limit`) or, for lists the node cannot page, to a position in the full list.
export const PAGE_LIMIT_MAX = 200;
export interface PageRequest {
  cursor?: string;
  // 1 to PAGE_LIMIT_MAX; adapters use 50 when absent.
  limit?: number;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

// Credential state and access level of a node (credential scopes §1). `credential` is about the spend credential:
// `missing` when none was given, `revoked` when the node no longer accepts it.
export const ACCESS_LEVELS = ['read-only', 'standard', 'full', 'admin'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export const CREDENTIAL_STATES = ['ok', 'revoked', 'missing'] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

// Named feature flags (domain and adapter §4). An adapter reports those its implementation, version, plugins and
// credentials allow; the server removes those the chain profile does not allow.
export const CAPABILITIES = [
  'node.info',
  'balances',
  'peers',
  'peers.manage',
  'channels.list',
  'channels.closed',
  'htlcs.list',
  'channels.open',
  'channels.close',
  'channels.close.force',
  'channels.policy',
  'receive.bolt11',
  'receive.onchain',
  'receive.offer',
  'pay.bolt11',
  'pay.bolt12',
  'pay.keysend',
  'pay.mpp',
  'pay.route_preview',
  'onchain.send',
  'onchain.send_max',
  'onchain.utxos',
  'onchain.bump',
  'routing.forwards',
  'routing.forwards.failed',
  'fees.node_estimates',
  'chain.identity',
  'events.invoices',
  'events.payments',
  'events.forwards',
  'events.blocks',
  'accounting.bookkeeper',
  'rebalance.manual',
  'node.sign_message',
  'node.config',
  'node.stop',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface NodeStatus {
  reachable: boolean;
  // Last time the node answered this adapter (in this process).
  lastSeenAt?: string;
  credential: CredentialState;
  accessLevel: AccessLevel;
  capabilities: Capability[];
}

export interface Peer {
  pubkey: Pubkey;
  alias?: UntrustedText;
  connected: boolean;
  // Addresses the node knows for the peer (connected address first), as host:port.
  addresses: string[];
  features?: string;
  numChannels: number;
}

// The implementation's own state (`native`, with a readable `nativeLabel`) is what the owner sees; `group` is ours,
// used only to sort, filter and count. A state the adapter does not know has group `unknown`.
export const CHANNEL_STATE_GROUPS = [
  'opening',
  'active',
  'inactive',
  'splicing',
  'closing',
  'closed',
  'unknown',
] as const;
export type ChannelStateGroup = (typeof CHANNEL_STATE_GROUPS)[number];
export interface ChannelState {
  group: ChannelStateGroup;
  native: string;
  nativeLabel: string;
}

export interface ChannelPolicy {
  baseFeeMsat: Msat;
  feePpm: number;
  minHtlcMsat: Msat;
  maxHtlcMsat: Msat;
  cltvDelta: number;
}

export interface Channel {
  id: ChannelId;
  shortChannelId?: ShortChannelId;
  peer: { pubkey: Pubkey; alias?: UntrustedText };
  state: ChannelState;
  opener: 'local' | 'remote';
  private: boolean;
  capacity: Msat;
  local: Msat;
  remote: Msat;
  spendable: Msat;
  receivable: Msat;
  reserves: { ours: Msat; theirs: Msat };
  fundingOutpoint: FundingOutpoint;
  // Our side's forwarding policy; absent until the node has one (channel still opening).
  policy?: ChannelPolicy;
  // Channel type names as the node reports them (e.g. `anchors/even`, `unified_sigs/even` on BLAKE2b).
  channelType: string[];
  closeTo?: string;
  stats: { inFulfilled: Msat; outFulfilled: Msat; inPayments: number; outPayments: number };
}

export interface Htlc {
  shortChannelId: ShortChannelId;
  direction: 'in' | 'out';
  amount: Msat;
  paymentHash: PaymentHash;
  // Block height.
  expiry: number;
  // The node's own state name.
  state: string;
  // False once the HTLC has been removed from the channel (settled or failed).
  inFlight: boolean;
}

export const CLOSE_CAUSES = ['local', 'remote', 'mutual', 'onchain', 'unknown'] as const;
export type CloseCause = (typeof CLOSE_CAUSES)[number];
export interface ClosedChannel {
  id: ChannelId;
  shortChannelId?: ShortChannelId;
  peer?: { pubkey: Pubkey; alias?: UntrustedText };
  capacity: Msat;
  finalLocal: Msat;
  closeCause: CloseCause;
  // The node's own cause name (CLN `close_cause`).
  closeCauseRaw: string;
  fundingOutpoint: FundingOutpoint;
  // Not every node reports these (CLN `listclosedchannels` has neither).
  closingTxid?: Txid;
  closedAt?: string;
}

export interface Offer {
  id: string;
  bolt12: string;
  amount?: Msat;
  description?: UntrustedText;
  label?: string;
  active: boolean;
  singleUse: boolean;
  used: boolean;
}

// The address types a node can be asked for (the decoder's AddressType lists every type we can pay to).
export const NEW_ADDRESS_TYPES = ['p2wpkh', 'p2tr'] as const;
export type NewAddressType = (typeof NEW_ADDRESS_TYPES)[number];
export interface NewAddress {
  address: string;
  type: NewAddressType;
  createdAt: string;
}

export const ONCHAIN_TX_KINDS = ['receive', 'send', 'channel-open', 'channel-close', 'other'] as const;
export type OnchainTxKind = (typeof ONCHAIN_TX_KINDS)[number];
export interface OnchainTx {
  txid: Txid;
  // Net effect on the wallet: positive received, negative sent. Absent when the node cannot tell (an old CLN whose
  // listtransactions has no inputs and outputs, and no bookkeeper plugin).
  amount?: { direction: 'in' | 'out'; value: Msat };
  fee?: Msat;
  blockHeight?: number;
  confirmations: number;
  label?: string;
  kind: OnchainTxKind;
}

export interface Utxo {
  outpoint: FundingOutpoint;
  amount: Msat;
  address?: string;
  status: 'unconfirmed' | 'confirmed' | 'spent' | 'immature' | 'unknown';
  reserved: boolean;
  blockHeight?: number;
}

// Fee rates in sat/vB as decimal strings (domain and adapter §1).
export type SatPerVbyte = string;
export interface FeeEstimates {
  source: 'node' | 'explorer';
  at: string;
  rates: { fastest: SatPerVbyte; halfHour: SatPerVbyte; hour: SatPerVbyte; economy: SatPerVbyte; minimum: SatPerVbyte };
  node?: { opening?: SatPerVbyte; mutualClose?: SatPerVbyte; unilateralClose?: SatPerVbyte };
}

export const FORWARD_STATUSES = ['settled', 'failed', 'local_failed', 'offered', 'unknown'] as const;
export type ForwardStatus = (typeof FORWARD_STATUSES)[number];
export interface Forward {
  inChannel: ShortChannelId;
  outChannel?: ShortChannelId;
  amountIn: Msat;
  amountOut?: Msat;
  fee?: Msat;
  status: ForwardStatus;
  statusRaw: string;
  receivedAt: string;
  resolvedAt?: string;
  failCode?: number;
}

export interface RoutePreview {
  // Estimated fee of the cheapest route found; the payment may take another route, the fee cap is what binds.
  fee: Msat;
  hops: number;
  // Success probability as the node estimates it, in parts per million.
  probabilityPpm: number;
}

export interface Plugin {
  name: string;
  active: boolean;
}

// What the node's decoder says about a payment request (PayPort.decode). Shown to the owner only: payment decisions
// use our own decoder (decode/), never this.
export interface NodeDecoded {
  type: string;
  valid: boolean;
  amount?: Msat;
  payee?: Pubkey;
  paymentHash?: PaymentHash;
  description?: UntrustedText;
}

// Events an adapter produces from the node (domain and adapter §6.2, the node-sourced types). The server's event
// bus adds the envelope (`id`, `at`, `node`) and the types computed by the server.
export type NodeEvent =
  | { type: 'invoice.paid'; data: { paymentHash: PaymentHash; amountReceived: Msat; label: string } }
  | { type: 'invoice.expired'; data: { paymentHash: PaymentHash; label: string } }
  | {
      type: 'payment.updated';
      data: { paymentHash: PaymentHash; status: PaymentStatus; amountSent?: Msat; fee?: Msat };
    }
  | { type: 'forward.updated'; data: Forward }
  | { type: 'block.new'; data: { height: number } };
export type NodeEventType = NodeEvent['type'];
