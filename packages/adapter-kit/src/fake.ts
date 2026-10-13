// In-memory fake adapter. It behaves like a node of the given chain: a tip block in that chain's header format,
// the matching feature bits, signed BOLT11 invoices the full decoder accepts (with the chain's invoice feature
// bits), payments between fake nodes on the same FakeNetwork, channels, peers, on-chain coins and an event stream.
// Used by the server's tests and by the UI work, and held to the same contract suite as real adapters.
import { createHash, randomBytes } from 'node:crypto';
import { getPublicKey, signAsync } from '@noble/secp256k1';
import { bech32, bech32m } from '@scure/base';
import {
  AdapterError,
  CAPABILITIES,
  msat,
  PAGE_LIMIT_MAX,
  parseChannelId,
  parseFundingOutpoint,
  parsePaymentHash,
  parsePubkey,
  parseShortChannelId,
  parseTxid,
  readBolt11,
  sub,
  untrustedText,
  ZERO,
  type Balances,
  type Chain,
  type Channel,
  type ChannelPolicyRequest,
  type CloseChannelRequest,
  type CloseChannelResult,
  type ClosedChannel,
  type EventCursor,
  type FeeEstimates,
  type Invoice,
  type KeysendRequest,
  type Msat,
  type Network,
  type NewAddressType,
  type NewInvoice,
  type NewOffer,
  type NodeAdapter,
  type NodeDecoded,
  type NodeEvent,
  type NodeFacts,
  type NodeStatus,
  type Offer,
  type OnchainTx,
  type OpenChannelRequest,
  type Page,
  type PageRequest,
  type Payment,
  type PaymentHash,
  type PayRequest,
  type PayResult,
  type Peer,
  type PrepareRequest,
  type Pubkey,
  type RoutePreview,
  type RoutePreviewRequest,
  type Txid,
  type Utxo,
} from '@lightning-pilot/core';

interface FakeInvoice {
  owner: string;
  preimage: string;
  amount: Msat | undefined;
  description: string;
  label: string;
  bolt11: string;
  createdAt: number;
  expiresAt: number;
  paid: boolean;
  amountReceived?: Msat;
  paidAt?: number;
}

// Shared state of the fake nodes that can pay each other.
export class FakeNetwork {
  readonly invoices = new Map<string, FakeInvoice>();
  readonly nodes = new Map<string, FakeAdapter>();
  readonly offers = new Map<string, { owner: string; amount: Msat | undefined }>();
}

export interface FakeNodeOptions {
  chain: Chain;
  network?: Network;
  alias?: string;
  blockHeight?: number;
  canSpend?: boolean;
  world?: FakeNetwork;
}

const HRP: Record<Network, string> = { mainnet: 'lnbc', testnet4: 'lntb', signet: 'lntbs', regtest: 'lnbcrt' };
const ADDRESS_HRP: Record<Network, string> = { mainnet: 'bc', testnet4: 'tb', signet: 'tb', regtest: 'bcrt' };
const CLN_NETWORK: Record<Network, string> = {
  mainnet: 'bitcoin',
  testnet4: 'testnet4',
  signet: 'signet',
  regtest: 'regtest',
};
// The invoice features the nodes set (var_onion_optin, payment_secret, basic_mpp); the BLAKE2b fork adds bit 512
// (option_blake2b), which the BLAKE2b profile requires and the Bitcoin profile refuses.
const INVOICE_FEATURES: Record<Chain, number[]> = { blake2b: [8, 14, 17, 512], bitcoin: [8, 14, 17] };
const TAG = { p: 1, x: 6, '9': 5, d: 13, s: 16, c: 24 } as const;
const DEFAULT_PAGE = 50;

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());
const sha256hex = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

// A number field is a big-endian integer in as many 5-bit words as it needs (BOLT11), at least `min` words.
function numberWords(value: bigint, min = 1): number[] {
  const words: number[] = [];
  for (let v = value; v > 0n; v >>= 5n) words.unshift(Number(v & 31n));
  while (words.length < min) words.unshift(0);
  return words;
}
const field = (tag: number, words: number[]) => [tag, words.length >> 5, words.length & 31, ...words];
const bytesField = (tag: number, bytes: Uint8Array) => field(tag, bech32.toWords(bytes));

// Packs words into bytes, the last partial byte padded with zero bits: the data a BOLT11 signature covers.
function wordsToBytesPadded(words: number[]): Uint8Array {
  const out = new Uint8Array(Math.ceil((words.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[i++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0) out[i] = (acc << (8 - bits)) & 0xff;
  return out;
}

interface InvoiceFields {
  network: Network;
  chain: Chain;
  key: Uint8Array;
  amount: Msat | undefined;
  paymentHash: string;
  description: string;
  expirySeconds: number;
  timestamp: number;
}

// A signed BOLT11 invoice with the fields real nodes write: payment hash, payment secret, description, expiry, final
// CLTV delta and the chain's feature bits. The full decoder accepts it, and the chain rule passes for its profile.
async function signedBolt11(f: InvoiceFields): Promise<string> {
  // The pico-bitcoin multiplier: one msat is 10 p.
  const hrp = `${HRP[f.network]}${f.amount === undefined ? '' : `${f.amount * 10n}p`}`;
  const data = [
    ...numberWords(BigInt(f.timestamp), 7),
    ...bytesField(TAG.p, Buffer.from(f.paymentHash, 'hex')),
    ...bytesField(TAG.s, randomBytes(32)),
    ...bytesField(TAG.d, new TextEncoder().encode(f.description)),
    ...field(TAG.x, numberWords(BigInt(f.expirySeconds))),
    ...field(TAG.c, numberWords(18n)),
    ...field(TAG['9'], numberWords(INVOICE_FEATURES[f.chain].reduce((v, b) => v | (1n << BigInt(b)), 0n))),
  ];
  const message = sha256(Uint8Array.of(...new TextEncoder().encode(hrp), ...wordsToBytesPadded(data)));
  const recovered = await signAsync(message, f.key, { prehash: false, format: 'recovered' });
  // noble writes recovery ‖ r ‖ s; BOLT11 wants r ‖ s ‖ recovery.
  const signature = Uint8Array.of(...recovered.slice(1), recovered[0] ?? 0);
  return bech32.encode(hrp, [...data, ...bech32.toWords(signature)], false);
}

// The tip block in the chain's format: BLAKE2b 164-byte header with version 0xa0000000, Bitcoin 80-byte header
// with version 0x20000000; then one transaction (only its count is needed by the identity check).
function fakeBlock(chain: Chain): string {
  const header = chain === 'blake2b' ? '000000a0' + '00'.repeat(160) : '00000020' + '00'.repeat(76);
  return header + '01';
}

// Node feature bits: option_blake2b (bit 513, optional) on BLAKE2b; the usual low bits on both.
function fakeFeatures(chain: Chain): string {
  const low = '0898880a8a59a1';
  // Bit 513 is bit 1 of the 65th byte from the end.
  return chain === 'blake2b' ? '02' + '00'.repeat(64 - low.length / 2) + low : low;
}

function page<T>(all: T[], request: PageRequest | undefined): Page<T> {
  const limit = request?.limit ?? DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) throw invalid('page limit');
  const cursor = request?.cursor;
  if (cursor !== undefined && !/^f[0-9]{1,15}$/.test(cursor)) throw invalid('cursor');
  const start = cursor === undefined ? 0 : Number(cursor.slice(1));
  const items = all.slice(start, start + limit);
  return start + limit < all.length ? { items, nextCursor: `f${start + limit}` } : { items };
}

const invalid = (detail: string) =>
  new AdapterError({ code: 'validation_failed', sent: false, definitive: true, detail });
const randomHex = (bytes: number) => randomBytes(bytes).toString('hex');
const randomPubkey = () => parsePubkey(Buffer.from(getPublicKey(randomBytes(32), true)).toString('hex'));

interface FakeChannel {
  channel: Channel;
}

export class FakeAdapter implements NodeAdapter {
  readonly implementation = 'cln' as const;
  readonly #key = new Uint8Array(randomBytes(32));
  readonly pubkey = parsePubkey(Buffer.from(getPublicKey(this.#key, true)).toString('hex'));
  readonly calls: string[] = [];
  blockHeight: number;
  synced = true;
  // Overrides for identity tests: a different chain's tip block or feature bits.
  tipOverride: string | undefined;
  featuresOverride: string | undefined;
  #nextError: AdapterError | undefined;
  readonly #options: Required<Omit<FakeNodeOptions, 'world'>>;
  readonly #world: FakeNetwork;
  readonly #payments = new Map<string, Payment>();
  readonly #peers = new Map<string, { connected: boolean }>();
  readonly #channels: FakeChannel[] = [];
  readonly #closed: ClosedChannel[] = [];
  readonly #offers = new Map<string, Offer>();
  readonly #utxos: Utxo[] = [];
  readonly #prepared = new Map<string, { inputs: string[]; psbt: string; amount: Msat }>();
  readonly #transactions: OnchainTx[] = [];
  readonly #events: NodeEvent[] = [];
  readonly #listeners = new Set<() => void>();
  #local: Msat;

  constructor(options: FakeNodeOptions) {
    this.#options = {
      chain: options.chain,
      network: options.network ?? 'regtest',
      alias: options.alias ?? `fake-${options.chain}`,
      blockHeight: options.blockHeight ?? 1000,
      canSpend: options.canSpend ?? true,
    };
    this.blockHeight = this.#options.blockHeight;
    this.#world = options.world ?? new FakeNetwork();
    this.#world.nodes.set(this.pubkey, this);
    this.#local = msat(1_000_000_000n);
    // One active channel with an outside peer, as getInfo reports, and one confirmed coin.
    const peer = randomPubkey();
    this.#peers.set(peer, { connected: true });
    this.#channels.push({ channel: this.#newChannel(peer, msat(2_000_000_000n), this.#local, 'active') });
    const coinTx = parseTxid(randomHex(32));
    this.#utxos.push({
      outpoint: parseFundingOutpoint(`${coinTx}:0`),
      amount: msat(500_000_000n),
      address: this.#address('p2wpkh'),
      status: 'confirmed',
      reserved: false,
      blockHeight: this.blockHeight - 10,
    });
    this.#transactions.push({
      txid: coinTx,
      amount: { direction: 'in', value: msat(500_000_000n) },
      blockHeight: this.blockHeight - 10,
      confirmations: 11,
      kind: 'receive',
    });
  }

  // The next call fails with this error (once).
  failNext(error: AdapterError): void {
    this.#nextError = error;
  }

  // Test helper: mines blocks (the tip moves, channels being opened become active, a block.new event follows).
  mine(blocks = 1): void {
    this.blockHeight += blocks;
    for (const { channel } of this.#channels) {
      if (channel.state.group !== 'opening') continue;
      channel.state = { group: 'active', native: 'CHANNELD_NORMAL', nativeLabel: 'Normal' };
      channel.shortChannelId = parseShortChannelId(`${this.blockHeight}x1x0`);
    }
    this.#emit({ type: 'block.new', data: { height: this.blockHeight } });
  }

  // Test helper: an active channel with another node (a FakeAdapter on the same network, say), connected.
  addChannel(peer: Pubkey, capacity: Msat = msat(1_000_000_000n)): void {
    this.#peers.set(peer, { connected: true });
    this.#channels.push({ channel: this.#newChannel(peer, capacity, msat(capacity / 2n), 'active') });
  }

  #enter(method: string): void {
    this.calls.push(method);
    const error = this.#nextError;
    if (error) {
      this.#nextError = undefined;
      throw error;
    }
  }

  #spend(method: string): void {
    if (!this.#options.canSpend) throw new AdapterError({ code: 'permission_denied', sent: false, definitive: true });
    this.#enter(method);
  }

  #emit(event: NodeEvent): void {
    this.#events.push(event);
    for (const listener of this.#listeners) listener();
  }

  #address(type: NewAddressType): string {
    const hrp = ADDRESS_HRP[this.#options.network];
    return type === 'p2tr'
      ? bech32m.encode(hrp, [1, ...bech32m.toWords(randomBytes(32))])
      : bech32.encode(hrp, [0, ...bech32.toWords(randomBytes(20))]);
  }

  #newChannel(peer: Pubkey, capacity: Msat, local: Msat, group: 'active' | 'opening'): Channel {
    const txid = randomHex(32);
    return {
      id: parseChannelId(randomHex(32)),
      ...(group === 'active' ? { shortChannelId: parseShortChannelId(`${this.blockHeight - 100}x1x0`) } : {}),
      peer: { pubkey: peer },
      state:
        group === 'active'
          ? { group: 'active', native: 'CHANNELD_NORMAL', nativeLabel: 'Normal' }
          : { group: 'opening', native: 'CHANNELD_AWAITING_LOCKIN', nativeLabel: 'Waiting for funding confirmation' },
      opener: 'local',
      private: false,
      capacity,
      local,
      remote: sub(capacity, local),
      spendable: local,
      receivable: sub(capacity, local),
      reserves: { ours: msat(capacity / 100n), theirs: msat(capacity / 100n) },
      fundingOutpoint: parseFundingOutpoint(`${txid}:0`),
      policy: { baseFeeMsat: msat(1000n), feePpm: 10, minHtlcMsat: ZERO, maxHtlcMsat: capacity, cltvDelta: 34 },
      channelType: ['static_remotekey/even', 'anchors/even'],
      stats: { inFulfilled: ZERO, outFulfilled: ZERO, inPayments: 0, outPayments: 0 },
    };
  }

  #invoiceOf(paymentHash: string, invoice: FakeInvoice): Invoice {
    const expired = !invoice.paid && invoice.expiresAt <= now();
    return {
      paymentHash: parsePaymentHash(paymentHash),
      bolt11: invoice.bolt11,
      ...(invoice.amount === undefined ? {} : { amount: invoice.amount }),
      ...(invoice.amountReceived === undefined ? {} : { amountReceived: invoice.amountReceived }),
      description: untrustedText(invoice.description),
      label: invoice.label,
      status: invoice.paid ? 'paid' : expired ? 'expired' : 'unpaid',
      createdAt: iso(invoice.createdAt),
      expiresAt: iso(invoice.expiresAt),
      ...(invoice.paidAt === undefined ? {} : { paidAt: iso(invoice.paidAt) }),
      ...(invoice.paid ? { preimage: invoice.preimage } : {}),
    };
  }

  // Credits a payment to this node: invoice paid and an invoice.paid event.
  #receive(paymentHash: string, amount: Msat): void {
    const invoice = this.#world.invoices.get(paymentHash);
    if (invoice) {
      invoice.paid = true;
      invoice.amountReceived = amount;
      invoice.paidAt = now();
      this.#emit({
        type: 'invoice.paid',
        data: { paymentHash: parsePaymentHash(paymentHash), amountReceived: amount, label: invoice.label },
      });
    }
  }

  #record(paymentHash: string, payment: Payment): PayResult {
    this.#local = msat(this.#local - (payment.amountSent ?? ZERO));
    this.#payments.set(paymentHash, payment);
    this.#emit({
      type: 'payment.updated',
      data: {
        paymentHash: parsePaymentHash(paymentHash),
        status: 'succeeded',
        ...(payment.amountSent ? { amountSent: payment.amountSent, fee: ZERO } : {}),
      },
    });
    const amount = payment.amount ?? ZERO;
    return {
      paymentHash: parsePaymentHash(paymentHash),
      preimage: payment.preimage ?? '',
      amount,
      amountSent: amount,
      fee: ZERO,
    };
  }

  readonly node = {
    getInfo: async (): Promise<NodeFacts> => {
      this.#enter('getInfo');
      return {
        pubkey: this.pubkey,
        alias: untrustedText(this.#options.alias),
        color: '024470',
        implementation: 'cln',
        version: 'fake',
        network: this.#options.network,
        networkRaw: CLN_NETWORK[this.#options.network],
        blockHeight: this.blockHeight,
        synced: this.synced,
        numPeers: this.#peers.size,
        numActiveChannels: this.#channels.filter((c) => c.channel.state.group === 'active').length,
        numPendingChannels: this.#channels.filter((c) => c.channel.state.group === 'opening').length,
        numInactiveChannels: this.#channels.filter((c) => c.channel.state.group === 'inactive').length,
        features: this.featuresOverride ?? fakeFeatures(this.#options.chain),
      };
    },
    getStatus: async (): Promise<NodeStatus> => {
      this.#enter('getStatus');
      const spend = this.#options.canSpend;
      // A fake has no bookkeeper and makes no fee bumps, rebalances or node-control calls.
      const unsupported = new Set([
        'accounting.bookkeeper',
        'onchain.bump',
        'rebalance.manual',
        'node.sign_message',
        'node.config',
        'node.stop',
      ]);
      const spendOnly = new Set([
        'peers.manage',
        'channels.open',
        'channels.close',
        'channels.close.force',
        'channels.policy',
        'pay.bolt11',
        'pay.bolt12',
        'pay.keysend',
        'pay.mpp',
        'onchain.send',
        'onchain.send_max',
      ]);
      return {
        reachable: true,
        lastSeenAt: new Date().toISOString(),
        credential: spend ? 'ok' : 'missing',
        accessLevel: spend ? 'standard' : 'read-only',
        capabilities: CAPABILITIES.filter((c) => !unsupported.has(c) && (spend || !spendOnly.has(c))),
      };
    },
  };

  readonly chain = {
    getTipHeader: async () => {
      this.#enter('getTipHeader');
      return { height: this.blockHeight, raw: this.tipOverride ?? fakeBlock(this.#options.chain) };
    },
    getHeaderAt: async (height: number) => {
      this.#enter('getHeaderAt');
      if (!Number.isInteger(height) || height < 0 || height > this.blockHeight) {
        throw new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: -1 });
      }
      return { height, raw: fakeBlock(this.#options.chain) };
    },
    getFeeEstimates: async (): Promise<FeeEstimates> => {
      this.#enter('getFeeEstimates');
      return {
        source: 'node',
        at: new Date().toISOString(),
        rates: { fastest: '20', halfHour: '12', hour: '8', economy: '2', minimum: '1.012' },
        node: { opening: '8', mutualClose: '2', unilateralClose: '12' },
      };
    },
    isSynced: async () => {
      this.#enter('isSynced');
      return this.synced;
    },
  };

  readonly balance = {
    getBalances: async (): Promise<Balances> => {
      this.#enter('getBalances');
      const coins = this.#utxos.filter((u) => u.status !== 'spent');
      const sum = (values: Msat[]) => msat(values.reduce<bigint>((a, b) => a + b, 0n));
      return {
        onchain: {
          confirmed: sum(coins.filter((u) => u.status === 'confirmed' && !u.reserved).map((u) => u.amount)),
          unconfirmed: sum(coins.filter((u) => u.status === 'unconfirmed' && !u.reserved).map((u) => u.amount)),
          reserved: sum(coins.filter((u) => u.reserved).map((u) => u.amount)),
        },
        lightning: {
          local: this.#local,
          spendable: this.#local,
          remote: msat(1_000_000_000n),
          receivable: msat(1_000_000_000n),
        },
        pendingClose: ZERO,
      };
    },
  };

  readonly peer = {
    listPeers: async (): Promise<Peer[]> => {
      this.#enter('listPeers');
      return [...this.#peers].map(([pubkey, p]) => ({
        pubkey: parsePubkey(pubkey),
        connected: p.connected,
        addresses: ['127.0.0.1:9735'],
        numChannels: this.#channels.filter((c) => c.channel.peer.pubkey === pubkey).length,
      }));
    },
    connect: async (uri: string) => {
      this.#spend('connect');
      const pubkey = uri.split('@')[0] ?? '';
      if (!/^0[23][0-9a-f]{64}$/.test(pubkey)) throw invalid('node URI');
      this.#peers.set(pubkey, { connected: true });
      return { pubkey: parsePubkey(pubkey) };
    },
    disconnect: async (pubkey: Pubkey, options?: { force?: boolean }) => {
      this.#spend('disconnect');
      const hasChannels = this.#channels.some((c) => c.channel.peer.pubkey === pubkey);
      // Like CLN: a peer with channels is only dropped when forced.
      if (hasChannels && options?.force !== true) {
        throw new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: -1 });
      }
      const peer = this.#peers.get(pubkey);
      if (peer) peer.connected = false;
    },
  };

  readonly channel = {
    listChannels: async (request?: PageRequest) => {
      this.#enter('listChannels');
      return page(
        this.#channels.map((c) => c.channel),
        request,
      );
    },
    listClosedChannels: async (request?: PageRequest) => {
      this.#enter('listClosedChannels');
      return page(this.#closed, request);
    },
    listHtlcs: async (request?: PageRequest) => {
      this.#enter('listHtlcs');
      return page([], request);
    },
    openChannel: async (request: OpenChannelRequest) => {
      this.#spend('openChannel');
      if (!this.#peers.get(request.peer)?.connected) {
        throw new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: -1 });
      }
      const amount = request.amount === 'all' ? msat(400_000_000n) : request.amount;
      const channel = this.#newChannel(request.peer, amount, amount, 'opening');
      this.#channels.push({ channel });
      const [txid, outnum] = channel.fundingOutpoint.split(':');
      return { channelId: channel.id, txid: parseTxid(txid ?? ''), outnum: Number(outnum) };
    },
    closeChannel: async (request: CloseChannelRequest): Promise<CloseChannelResult> => {
      this.#spend('closeChannel');
      const index = this.#channels.findIndex(
        (c) => c.channel.id === request.channel || c.channel.shortChannelId === request.channel,
      );
      const found = this.#channels[index];
      if (!found) throw new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: -32602 });
      this.#channels.splice(index, 1);
      const c = found.channel;
      this.#closed.push({
        id: c.id,
        ...(c.shortChannelId === undefined ? {} : { shortChannelId: c.shortChannelId }),
        peer: c.peer,
        capacity: c.capacity,
        finalLocal: c.local,
        closeCause: 'local',
        closeCauseRaw: 'user',
        fundingOutpoint: c.fundingOutpoint,
      });
      if (c.state.group === 'opening') return { type: 'unopened' };
      return { type: request.force ? 'unilateral' : 'mutual', txids: [parseTxid(randomHex(32))] };
    },
    setPolicy: async (request: ChannelPolicyRequest) => {
      this.#spend('setPolicy');
      for (const { channel } of this.#channels) {
        if (request.channel !== 'all' && channel.id !== request.channel && channel.shortChannelId !== request.channel)
          continue;
        if (!channel.policy) continue;
        channel.policy = {
          ...channel.policy,
          ...(request.baseFeeMsat === undefined ? {} : { baseFeeMsat: request.baseFeeMsat }),
          ...(request.feePpm === undefined ? {} : { feePpm: request.feePpm }),
          ...(request.minHtlcMsat === undefined ? {} : { minHtlcMsat: request.minHtlcMsat }),
          ...(request.maxHtlcMsat === undefined ? {} : { maxHtlcMsat: request.maxHtlcMsat }),
        };
      }
    },
  };

  readonly receive = {
    createInvoice: async (request: NewInvoice): Promise<Invoice> => {
      this.#enter('createInvoice');
      const preimage = randomHex(32);
      const paymentHash = sha256hex(preimage);
      const expirySeconds = request.expirySeconds ?? 3600;
      const timestamp = now();
      const bolt11 = await signedBolt11({
        network: this.#options.network,
        chain: this.#options.chain,
        key: this.#key,
        amount: request.amount,
        paymentHash,
        description: request.description,
        expirySeconds,
        timestamp,
      });
      const invoice: FakeInvoice = {
        owner: this.pubkey,
        preimage,
        amount: request.amount,
        description: request.description,
        label: request.label,
        bolt11,
        createdAt: timestamp,
        expiresAt: timestamp + expirySeconds,
        paid: false,
      };
      this.#world.invoices.set(paymentHash, invoice);
      return this.#invoiceOf(paymentHash, invoice);
    },
    listInvoices: async (request?: PageRequest) => {
      this.#enter('listInvoices');
      const own = [...this.#world.invoices].filter(([, i]) => i.owner === this.pubkey);
      return page(
        own.map(([hash, i]) => this.#invoiceOf(hash, i)),
        request,
      );
    },
    getInvoice: async (paymentHash: PaymentHash) => {
      this.#enter('getInvoice');
      const invoice = this.#world.invoices.get(paymentHash);
      return invoice?.owner === this.pubkey ? this.#invoiceOf(paymentHash, invoice) : undefined;
    },
    newAddress: async (type: NewAddressType) => {
      this.#enter('newAddress');
      return { address: this.#address(type), type, createdAt: new Date().toISOString() };
    },
    createOffer: async (request: NewOffer): Promise<Offer> => {
      this.#enter('createOffer');
      const id = randomHex(32);
      const offer: Offer = {
        id,
        bolt12: `lno1${bech32.encode('x', bech32.toWords(Buffer.from(id, 'hex'))).slice(2)}`,
        ...(request.amount === undefined ? {} : { amount: request.amount }),
        description: untrustedText(request.description),
        ...(request.label === undefined ? {} : { label: request.label }),
        active: true,
        singleUse: request.singleUse === true,
        used: false,
      };
      this.#offers.set(id, offer);
      this.#world.offers.set(offer.bolt12, { owner: this.pubkey, amount: request.amount });
      return offer;
    },
    listOffers: async () => {
      this.#enter('listOffers');
      return [...this.#offers.values()];
    },
    disableOffer: async (id: string) => {
      this.#enter('disableOffer');
      const offer = this.#offers.get(id);
      if (!offer) throw new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: -1 });
      offer.active = false;
      return offer;
    },
  };

  readonly pay = {
    decode: async (text: string): Promise<NodeDecoded> => {
      this.#enter('decode');
      try {
        const basics = readBolt11(text);
        return {
          type: 'bolt11 invoice',
          valid: true,
          ...(basics.amount === undefined ? {} : { amount: basics.amount }),
          paymentHash: basics.paymentHash,
        };
      } catch {
        return { type: 'unknown', valid: false };
      }
    },
    previewRoute: async (request: RoutePreviewRequest): Promise<RoutePreview | undefined> => {
      this.#enter('previewRoute');
      return this.#world.nodes.has(request.destination) && request.destination !== this.pubkey
        ? { fee: ZERO, hops: 1, probabilityPpm: 1_000_000 }
        : undefined;
    },
    fetchOfferInvoice: async (offer: string, amount?: Msat) => {
      this.#enter('fetchOfferInvoice');
      const known = this.#world.offers.get(offer);
      const issuer = known && this.#world.nodes.get(known.owner);
      if (!known || !issuer)
        throw new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: 1005 });
      const value = known.amount ?? amount;
      if (value === undefined) throw invalid('amount');
      // A fake BOLT12 invoice: the fake pays BOLT11 only, so this text is for display and decoding checks.
      return `lni1${bech32.encode('x', bech32.toWords(randomBytes(32))).slice(2)}`;
    },
    listPayments: async (request?: PageRequest) => {
      this.#enter('listPayments');
      return page([...this.#payments.values()], request);
    },
    getPayment: async (paymentHash: PaymentHash) => {
      this.#enter('getPayment');
      return this.#payments.get(paymentHash);
    },
    listByLabel: async (label: string) => {
      this.#enter('listByLabel');
      return [...this.#payments.values()].filter((p) => p.label === label);
    },
    pay: async (request: PayRequest): Promise<PayResult> => {
      this.#spend('pay');
      const decoded = readBolt11(request.bolt11);
      const invoice = this.#world.invoices.get(decoded.paymentHash);
      // An invoice no fake node issued has no route: the node definitely paid nothing.
      if (!invoice || invoice.owner === this.pubkey) {
        throw new AdapterError({ code: 'payment_failed', sent: true, definitive: true, nodeCode: 205 });
      }
      if (invoice.paid) throw new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: 219 });
      const amount = invoice.amount ?? request.amount;
      if (amount === undefined) throw invalid('amount');
      const payee = this.#world.nodes.get(invoice.owner);
      if (payee) payee.#receive(decoded.paymentHash, amount);
      return this.#record(decoded.paymentHash, {
        paymentHash: decoded.paymentHash,
        status: 'succeeded',
        destination: parsePubkey(invoice.owner),
        amount,
        amountSent: amount,
        fee: ZERO,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        preimage: invoice.preimage,
        label: request.label,
        parts: 1,
      });
    },
    keysend: async (request: KeysendRequest): Promise<PayResult> => {
      this.#spend('keysend');
      if (!this.#world.nodes.has(request.destination) || request.destination === this.pubkey) {
        throw new AdapterError({ code: 'payment_failed', sent: true, definitive: true, nodeCode: 205 });
      }
      const preimage = randomHex(32);
      const paymentHash = parsePaymentHash(sha256hex(preimage));
      return this.#record(paymentHash, {
        paymentHash,
        status: 'succeeded',
        destination: request.destination,
        amount: request.amount,
        amountSent: request.amount,
        fee: ZERO,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        preimage,
        label: request.label,
        parts: 1,
      });
    },
  };

  readonly onchain = {
    listTransactions: async (request?: PageRequest) => {
      this.#enter('listTransactions');
      return page([...this.#transactions].reverse(), request);
    },
    listUtxos: async () => {
      this.#enter('listUtxos');
      return this.#utxos.map((u) => ({ ...u }));
    },
    prepare: async (request: PrepareRequest) => {
      this.#spend('prepare');
      const total = request.outputs.reduce<bigint>((sum, o) => sum + (o.amount === 'all' ? 0n : o.amount), 0n);
      const free = this.#utxos.filter((u) => u.status === 'confirmed' && !u.reserved);
      const available = free.reduce<bigint>((sum, u) => sum + u.amount, 0n);
      if (available === 0n || total > available) {
        throw new AdapterError({ code: 'node_error', sent: true, definitive: true, nodeCode: 301 });
      }
      for (const u of free) u.reserved = true;
      const txid = parseTxid(randomHex(32));
      const psbt = Buffer.from(`fake-psbt:${txid}`).toString('base64');
      const all = request.outputs.some((o) => o.amount === 'all');
      this.#prepared.set(txid, { inputs: free.map((u) => u.outpoint), psbt, amount: msat(all ? available : total) });
      return { txid, psbt };
    },
    send: async (txid: Txid) => {
      this.#spend('send');
      const prepared = this.#prepared.get(txid);
      if (!prepared) throw new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: -1 });
      this.#prepared.delete(txid);
      for (const u of this.#utxos) if (prepared.inputs.includes(u.outpoint)) u.status = 'spent';
      this.#transactions.push({
        txid,
        amount: { direction: 'out', value: prepared.amount },
        confirmations: 0,
        kind: 'send',
      });
      return { txid };
    },
    discard: async (txid: Txid) => {
      this.#spend('discard');
      const prepared = this.#prepared.get(txid);
      if (!prepared) throw new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: -1 });
      this.#prepared.delete(txid);
      for (const u of this.#utxos) if (prepared.inputs.includes(u.outpoint)) u.reserved = false;
    },
    unreserve: async (psbt: string) => {
      this.#spend('unreserve');
      for (const [txid, prepared] of this.#prepared) {
        if (prepared.psbt !== psbt) continue;
        this.#prepared.delete(txid);
        for (const u of this.#utxos) if (prepared.inputs.includes(u.outpoint)) u.reserved = false;
      }
    },
  };

  readonly routing = {
    listForwards: async (request?: PageRequest) => {
      this.#enter('listForwards');
      return page([], request);
    },
  };

  readonly events = {
    subscribe: (
      cursor?: EventCursor,
      signal?: AbortSignal,
    ): AsyncIterable<{ event: NodeEvent; cursor: EventCursor }> => {
      this.#enter('subscribe');
      if (cursor !== undefined && !/^fake\.[0-9]{1,15}$/.test(cursor)) throw invalid('event cursor');
      const events = this.#events;
      const listeners = this.#listeners;
      let next = cursor === undefined ? events.length : Number(cursor.slice(5));
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            const event = events[next];
            if (event) {
              next += 1;
              yield { event, cursor: `fake.${next}` };
              continue;
            }
            await new Promise<void>((resolve) => {
              const wake = () => {
                listeners.delete(wake);
                signal?.removeEventListener('abort', wake);
                resolve();
              };
              listeners.add(wake);
              signal?.addEventListener('abort', wake, { once: true });
            });
          }
        },
      };
    },
  };

  readonly plugin = {
    listPlugins: async () => {
      this.#enter('listPlugins');
      return [{ name: 'fake', active: true }];
    },
  };

  // Test helper: has this invoice (made by this fake) been paid?
  isPaid(paymentHash: string): boolean {
    return this.#world.invoices.get(paymentHash)?.paid === true;
  }
}
