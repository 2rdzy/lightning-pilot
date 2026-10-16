// The adapter contract: one interface per implementation, split into ports (domain and adapter §3). Methods marked
// "spend" need the spend credential and are called only by the server's spend module; the others need the view &
// receive credential. Adapters never retry spend calls.
import type {
  Balances,
  Channel,
  ClosedChannel,
  FeeEstimates,
  Forward,
  Htlc,
  Implementation,
  Invoice,
  NodeDecoded,
  NodeEvent,
  NodeFacts,
  NewAddress,
  NewAddressType,
  NodeStatus,
  OnchainTx,
  Offer,
  Page,
  PageRequest,
  Payment,
  PayResult,
  Peer,
  Plugin,
  RoutePreview,
  SatPerVbyte,
  Utxo,
} from './domain.ts';
import type { ChannelId, PaymentHash, Pubkey, ShortChannelId, Txid } from './ids.ts';
import type { Msat } from './money.ts';

export interface RuneCheckPort {
  // Tests another rune through the view credential; never executes the named method.
  checkRune(rune: string, method: string, params?: Record<string, string>): Promise<boolean>;
}

export interface NodePort {
  getInfo(): Promise<NodeFacts>;
  // Reachability, the spend credential's state, the access level and the capabilities. Makes several node calls:
  // for status screens and node checks, not for polling.
  getStatus(): Promise<NodeStatus>;
}

export interface ChainPort {
  // The latest block: its height and its raw bytes as hex. The bytes start with the block header and include at
  // least the transaction count, so the header format can be checked (CLN returns the whole block).
  getTipHeader(): Promise<{ height: number; raw: string }>;
  // The block at a height, in the same form.
  getHeaderAt(height: number): Promise<{ height: number; raw: string }>;
  getFeeEstimates(): Promise<FeeEstimates>;
  // The node's chain backend has caught up with the best chain it knows, and the node with its backend.
  isSynced(): Promise<boolean>;
}

export interface BalancePort {
  getBalances(): Promise<Balances>;
}

export interface PeerPort {
  listPeers(): Promise<Peer[]>;
  // spend: `pubkey@host:port` (or a pubkey the node can find an address for).
  connect(uri: string): Promise<{ pubkey: Pubkey }>;
  // spend. `force` also drops a peer that still has channels (offered only in the Advanced view).
  disconnect(pubkey: Pubkey, options?: { force?: boolean }): Promise<void>;
}

export interface OpenChannelRequest {
  peer: Pubkey;
  // Funding amount, whole satoshis in msat (the node funds in satoshis), or 'all' for every confirmed coin.
  amount: Msat | 'all';
  feeRate?: SatPerVbyte;
  announce?: boolean;
  pushMsat?: Msat;
  // Our intent id is not sent: the node has no label for opens; recovery finds the channel by peer and txid.
  minConf?: number;
}

export interface OpenChannelResult {
  channelId: ChannelId;
  txid: Txid;
  outnum: number;
}

export interface CloseChannelRequest {
  // Channel id or short channel id.
  channel: ChannelId | ShortChannelId;
  // A cooperative close waits for the peer indefinitely; a force close publishes our commitment transaction at once.
  force: boolean;
  // Close to an address outside the node's wallet (a spend of its own, spend policy §1).
  destination?: string;
}

export type CloseChannelResult =
  | { type: 'mutual' | 'unilateral'; txids: Txid[] }
  | { type: 'unopened' }
  // The node took the request but did not answer within the adapter's short timeout; follow the channel state.
  | { type: 'pending' };

export interface ChannelPolicyRequest {
  // Channel id, short channel id, or 'all'.
  channel: ChannelId | ShortChannelId | 'all';
  baseFeeMsat?: Msat;
  feePpm?: number;
  minHtlcMsat?: Msat;
  maxHtlcMsat?: Msat;
}

export interface ChannelPort {
  listChannels(page?: PageRequest): Promise<Page<Channel>>;
  listClosedChannels(page?: PageRequest): Promise<Page<ClosedChannel>>;
  // HTLCs, oldest first, optionally of one channel; `inFlight` tells the current ones from the history.
  listHtlcs(page?: PageRequest, channel?: ChannelId | ShortChannelId): Promise<Page<Htlc>>;
  // spend.
  openChannel(request: OpenChannelRequest): Promise<OpenChannelResult>;
  // spend.
  closeChannel(request: CloseChannelRequest): Promise<CloseChannelResult>;
  // spend.
  setPolicy(request: ChannelPolicyRequest): Promise<void>;
}

export interface NewInvoice {
  // Absent: an invoice for any amount.
  amount?: Msat;
  description: string;
  label: string;
  expirySeconds?: number;
  // Advanced option: route hints through private channels (the node's default otherwise).
  exposePrivateChannels?: boolean;
}

export interface NewOffer {
  // Absent: any amount.
  amount?: Msat;
  description: string;
  label?: string;
  singleUse?: boolean;
}

export interface ReceivePort {
  createInvoice(request: NewInvoice): Promise<Invoice>;
  // Oldest first.
  listInvoices(page?: PageRequest): Promise<Page<Invoice>>;
  getInvoice(paymentHash: PaymentHash): Promise<Invoice | undefined>;
  newAddress(type: NewAddressType): Promise<NewAddress>;
  createOffer(request: NewOffer): Promise<Offer>;
  listOffers(): Promise<Offer[]>;
  disableOffer(id: string): Promise<Offer>;
}

export interface PayRequest {
  bolt11: string;
  // For an invoice without an amount.
  amount?: Msat;
  maxFee: Msat;
  // Our spend intent id, stored by the node with the payment so its outcome can be found after a crash.
  label: string;
  retryForSeconds: number;
}

export interface KeysendRequest {
  destination: Pubkey;
  amount: Msat;
  maxFee: Msat;
  label: string;
  retryForSeconds: number;
}

export interface RoutePreviewRequest {
  destination: Pubkey;
  amount: Msat;
  maxFee: Msat;
  finalCltv: number;
}

export interface PayPort {
  // read: the node's own decoding, for display; never used to decide a payment.
  decode(text: string): Promise<NodeDecoded>;
  // read: an estimate of the route fee, or undefined when the node finds no route.
  previewRoute(request: RoutePreviewRequest): Promise<RoutePreview | undefined>;
  // read: asks the offer's issuer for an invoice (BOLT12); returns the invoice text.
  fetchOfferInvoice(offer: string, amount?: Msat): Promise<string>;
  // read: one row per payment, oldest first.
  listPayments(page?: PageRequest): Promise<Page<Payment>>;
  // read: the node's record of a payment, or undefined if it has none.
  getPayment(paymentHash: PaymentHash): Promise<Payment | undefined>;
  // read: the payments the node stored under a label (crash recovery of keysend, whose hash is only known after).
  listByLabel(label: string): Promise<Payment[]>;
  // spend: never retried by the adapter.
  pay(request: PayRequest): Promise<PayResult>;
  // spend: never retried by the adapter.
  keysend(request: KeysendRequest): Promise<PayResult>;
}

export interface OnchainOutput {
  address: string;
  // Whole satoshis in msat, or 'all' (send everything; only output).
  amount: Msat | 'all';
}

export interface PrepareRequest {
  outputs: OnchainOutput[];
  feeRate?: SatPerVbyte;
  minConf?: number;
  // Coin control: only these outpoints.
  utxos?: string[];
}

export interface OnchainPort {
  // Newest first.
  listTransactions(page?: PageRequest): Promise<Page<OnchainTx>>;
  listUtxos(): Promise<Utxo[]>;
  // spend: builds and signs nothing yet; reserves the inputs and returns the transaction id and PSBT, so the spend
  // can be identified before it is broadcast.
  prepare(request: PrepareRequest): Promise<{ txid: Txid; psbt: string }>;
  // spend: signs and broadcasts a prepared transaction.
  send(txid: Txid): Promise<{ txid: Txid }>;
  // spend: forgets a prepared transaction and releases its inputs.
  discard(txid: Txid): Promise<void>;
  // spend: releases the inputs of a PSBT (after a node restart, when `discard` no longer knows the transaction).
  unreserve(psbt: string): Promise<void>;
}

export interface RoutingPort {
  // Oldest first.
  listForwards(page?: PageRequest): Promise<Page<Forward>>;
}

// Where an event stream resumes. Opaque to the caller, who stores the latest one it has handled.
export type EventCursor = string;

export interface EventPort {
  // Events from the node, each with the cursor to resume after it. Without a cursor, the stream starts at the
  // present (no history). Ends when `signal` aborts; a node error ends it with an AdapterError (resubscribe with the
  // last cursor).
  subscribe(cursor?: EventCursor, signal?: AbortSignal): AsyncIterable<{ event: NodeEvent; cursor: EventCursor }>;
}

export interface PluginPort {
  listPlugins(): Promise<Plugin[]>;
}

export interface NodeAdapter {
  readonly implementation: Implementation;
  readonly node: NodePort;
  readonly chain: ChainPort;
  readonly balance: BalancePort;
  readonly peer: PeerPort;
  readonly channel: ChannelPort;
  readonly receive: ReceivePort;
  readonly pay: PayPort;
  readonly onchain: OnchainPort;
  readonly routing: RoutingPort;
  readonly events: EventPort;
  readonly plugin: PluginPort;
}
