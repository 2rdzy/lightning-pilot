// Core Lightning adapter over clnrest: every port of the adapter contract (domain and adapter §3) with the command
// choices of the reference pass. Every command it sends is in the method table (methods.ts), with the credential
// that table names; spend commands are never retried.
import { createHash } from 'node:crypto';
import {
  AdapterError,
  add,
  decodeNodeUri,
  DecodeError,
  msat,
  parseChannelId,
  parsePaymentHash,
  parsePubkey,
  parseTxid,
  readBolt11,
  sub,
  untrustedText,
  ZERO,
  type Balances,
  type CloseChannelResult,
  type Htlc,
  type Msat,
  type Network,
  type NodeAdapter,
  type NodeFacts,
  type Offer,
  type Payment,
  type PayResult,
  type Pubkey,
  type UntrustedText,
  type Utxo,
} from '@lightning-pilot/core';
import { ClnRestClient } from './client.ts';
import {
  checkOffsetPage,
  cursorStart,
  indexPage,
  invalidRequest,
  isoFromSeconds,
  makeCall,
  offsetPage,
  pageLimit,
  parse,
  perkbToSatPerVbyte,
  satPerVbyteToPerkb,
  sumMsat,
  wholeSats,
  type Transport,
} from './context.ts';
import { subscribe } from './events.ts';
import { channel, closedChannel, forward, invoice, payment } from './mappers.ts';
import { listTransactions } from './onchain.ts';
import {
  Close,
  Connect,
  Decode,
  Feerates,
  FetchInvoice,
  FundChannel,
  GetChainInfo,
  GetInfo,
  GetRoutes,
  InvoiceReply,
  ListClosedChannels,
  ListForwards,
  ListFunds,
  ListHtlcs,
  ListInvoices,
  ListNodes,
  ListPays,
  ListPeerChannels,
  ListPeers,
  ListSendPays,
  NewAddr,
  OfferRow,
  ListOffers,
  PluginList,
  RawBlock,
  TxPrepare,
  TxSend,
  XpayReply,
  type OfferRow as OfferRowType,
  type SendPayRow,
} from './schemas.ts';
import { CheckRune } from './schemas.ts';
import { getStatus } from './status.ts';

export interface ClnAdapterOptions {
  url: string;
  caCertificate: string;
  serverName: string;
  viewRune: string;
  spendRune?: string;
  readTimeoutMs?: number;
  // How long `close` and `fundchannel` may block before the adapter stops waiting (the node goes on; the channel
  // state is followed through events). Default 30 s.
  channelTimeoutMs?: number;
  // Observes every command sent (tests use it to prove the adapter calls only what the method table lists).
  onCall?: (command: string, credential: 'read' | 'spend') => void;
  // Replaces the HTTPS client; unit tests use it to play recorded node replies.
  transport?: Transport;
}

export type { Transport };

// The complete adapter: the ports the server uses today plus the rest of the contract.
export type ClnAdapter = ReturnType<typeof createClnAdapter>;

const NETWORKS: Record<string, Network> = {
  bitcoin: 'mainnet',
  testnet4: 'testnet4',
  signet: 'signet',
  regtest: 'regtest',
};

const OPEN_STATES = new Set(['CHANNELD_NORMAL', 'CHANNELD_AWAITING_SPLICE']);
const CLOSING_STATES = new Set([
  'CHANNELD_SHUTTING_DOWN',
  'CLOSINGD_SIGEXCHANGE',
  'CLOSINGD_COMPLETE',
  'AWAITING_UNILATERAL',
  'FUNDING_SPEND_SEEN',
  'ONCHAIN',
]);

// xpay / xkeysend failures after which the node made no payment, once listsendpays confirms that no part is pending
// or complete: -32602 invalid parameters (refused before anything is sent, e.g. an invoice the node cannot parse),
// 203 destination permanent failure, 205 route not found, 207 invoice expired, 210 stopped retrying, 212 invoice
// request invalid. Any other code is not definitive (CLN common/jsonrpc_errors.h).
const PAY_NOT_MADE = new Set([-32602, 203, 205, 207, 210, 212]);
// "Already paid" (injectpaymentonion): the node's records say what happened.
const PAY_ALREADY_PAID = 219;
// Funding failures before anything is broadcast (FUND_MAX_EXCEEDED, FUND_CANNOT_AFFORD,
// FUND_CANNOT_AFFORD_WITH_EMERGENCY): nothing was sent.
const FUND_NOT_SENT = new Set([300, 301, 313]);
// Aliases are looked up once per peer and kept this long (reference pass: one call per peer per refresh is slow on
// large nodes).
const ALIAS_TTL_MS = 60 * 60_000;
// Paging through listsendpays to find a label (crash recovery only).
const LABEL_SCAN_BATCH = 1000;

// Announced addresses as host:port. Types without a host (websocket) or of unknown kind are left out.
const announced = (entries: { type: string; address?: string | undefined; port: number }[]): string[] =>
  entries.flatMap((e) => {
    if (e.address === undefined || !['ipv4', 'ipv6', 'torv2', 'torv3', 'dns'].includes(e.type)) return [];
    return [e.type === 'ipv6' ? `[${e.address}]:${e.port}` : `${e.address}:${e.port}`];
  });

const preimageHash = (preimage: string) =>
  parsePaymentHash(createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex'));

const asDefinitive = (err: AdapterError, code: AdapterError['code'] = err.code) =>
  new AdapterError({
    code,
    sent: true,
    definitive: true,
    ...(err.nodeCode === undefined ? {} : { nodeCode: err.nodeCode }),
    ...(err.detail === undefined ? {} : { detail: err.detail }),
  });

// Sums the parts the node keeps for one payment (listsendpays rows of one payment hash).
function fromParts(paymentHash: string, parts: SendPayRow[]): Payment {
  const complete = parts.filter((p) => p.status === 'complete');
  let status: Payment['status'] =
    complete.length > 0 ? 'succeeded' : parts.some((p) => p.status === 'pending') ? 'pending' : 'failed';
  // An unknown part status is never read as "failed": only explicit failures count.
  if (status === 'failed' && parts.some((p) => p.status !== 'failed')) status = 'pending';
  const preimage = complete.find((p) => p.payment_preimage)?.payment_preimage;
  const label = parts.find((p) => p.label)?.label;
  const destination = parts.find((p) => p.destination)?.destination;
  const amountSent = complete.length > 0 ? sumMsat(complete.map((p) => p.amount_sent_msat ?? 0n)) : undefined;
  const amount =
    complete.length > 0 && complete.every((p) => p.amount_msat !== undefined)
      ? sumMsat(complete.map((p) => p.amount_msat ?? 0n))
      : undefined;
  return {
    paymentHash: parsePaymentHash(paymentHash),
    status,
    ...(destination === undefined ? {} : { destination: parsePubkey(destination) }),
    ...(amount === undefined ? {} : { amount }),
    ...(amountSent === undefined ? {} : { amountSent }),
    ...(amount !== undefined && amountSent !== undefined && amountSent >= amount
      ? { fee: sub(amountSent, amount) }
      : {}),
    ...(preimage && status === 'succeeded' ? { preimage } : {}),
    ...(label ? { label } : {}),
    parts: parts.length,
  };
}

export function createClnAdapter(options: ClnAdapterOptions) {
  const transport: Transport =
    options.transport ??
    new ClnRestClient({ url: options.url, caCertificate: options.caCertificate, serverName: options.serverName });
  const call = makeCall({
    transport,
    viewRune: options.viewRune,
    spendRune: options.spendRune,
    readTimeoutMs: options.readTimeoutMs ?? 30_000,
    onCall: options.onCall,
  });
  const channelTimeoutMs = options.channelTimeoutMs ?? 30_000;
  const lastSeen: { at?: string } = {};
  const aliases = new Map<string, { alias: UntrustedText | undefined; at: number }>();
  let ownId: Pubkey | undefined;

  async function info() {
    const reply = parse(GetInfo, await call('getinfo', {}));
    lastSeen.at = new Date().toISOString();
    ownId = parsePubkey(reply.id);
    return reply;
  }

  async function aliasOf(pubkey: string): Promise<UntrustedText | undefined> {
    const cached = aliases.get(pubkey);
    if (cached && Date.now() - cached.at < ALIAS_TTL_MS) return cached.alias;
    const { nodes } = parse(ListNodes, await call('listnodes', { id: pubkey }));
    const raw = nodes.find((n) => n.nodeid === pubkey)?.alias;
    const alias = raw === undefined ? undefined : untrustedText(raw);
    aliases.set(pubkey, { alias, at: Date.now() });
    return alias;
  }

  async function aliasesOf(pubkeys: string[]): Promise<Map<string, UntrustedText | undefined>> {
    const unique = [...new Set(pubkeys)];
    return new Map(await Promise.all(unique.map(async (p) => [p, await aliasOf(p)] as const)));
  }

  async function blockAt(height: number) {
    const block = parse(RawBlock, await call('getrawblockbyheight', { height }));
    return { height, raw: block.block };
  }

  async function sendPays(params: Record<string, unknown>) {
    return parse(ListSendPays, await call('listsendpays', params)).payments;
  }

  async function getPayment(paymentHash: string): Promise<Payment | undefined> {
    const parts = (await sendPays({ payment_hash: paymentHash })).filter((p) => p.payment_hash === paymentHash);
    return parts.length === 0 ? undefined : fromParts(paymentHash, parts);
  }

  async function listByLabel(label: string): Promise<Payment[]> {
    const byHash = new Map<string, SendPayRow[]>();
    let start = 0;
    while (true) {
      const rows = await sendPays({ index: 'created', start, limit: LABEL_SCAN_BATCH });
      for (const row of rows) {
        if (row.label !== label) continue;
        byHash.set(row.payment_hash, [...(byHash.get(row.payment_hash) ?? []), row]);
      }
      if (rows.length < LABEL_SCAN_BATCH) break;
      start = Math.max(...rows.map((r) => r.created_index ?? 0)) + 1;
    }
    return [...byHash].map(([hash, parts]) => fromParts(hash, parts));
  }

  // Only a node reply that clearly says nothing was paid, confirmed by the node's own payment records, is
  // definitive. Everything else stays "not definitive" so the spend is recorded as unknown, never as failed.
  async function classifyPayError(err: unknown, lookup: () => Promise<Payment[]>): Promise<unknown> {
    if (!(err instanceof AdapterError) || err.nodeCode === undefined || !err.sent) return err;
    if (!PAY_NOT_MADE.has(err.nodeCode)) return err;
    let records: Payment[];
    try {
      records = await lookup();
    } catch {
      return err;
    }
    return records.every((r) => r.status === 'failed') ? asDefinitive(err, 'payment_failed') : err;
  }

  // 219: the node says this invoice was paid before. Its records decide; a recorded success is returned as this
  // payment's result (spend policy §5.3: "look up and record as succeeded").
  async function alreadyPaid(err: unknown, paymentHash: string): Promise<PayResult | undefined> {
    if (!(err instanceof AdapterError) || err.nodeCode !== PAY_ALREADY_PAID) return undefined;
    let record: Payment | undefined;
    try {
      record = await getPayment(paymentHash);
    } catch {
      return undefined;
    }
    if (record?.status !== 'succeeded' || !record.preimage || record.amountSent === undefined) return undefined;
    const amount = record.amount ?? record.amountSent;
    return {
      paymentHash: record.paymentHash,
      preimage: record.preimage,
      amount,
      amountSent: record.amountSent,
      fee: record.amountSent >= amount ? sub(record.amountSent, amount) : ZERO,
    };
  }

  function payResult(reply: { payment_preimage: string; amount_msat: bigint; amount_sent_msat: bigint }): PayResult {
    const fee =
      reply.amount_sent_msat >= reply.amount_msat ? sub(msat(reply.amount_sent_msat), msat(reply.amount_msat)) : ZERO;
    return {
      paymentHash: preimageHash(reply.payment_preimage),
      preimage: reply.payment_preimage,
      amount: msat(reply.amount_msat),
      amountSent: msat(reply.amount_sent_msat),
      fee,
    };
  }

  async function fundError<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof AdapterError && err.sent && err.nodeCode !== undefined && FUND_NOT_SENT.has(err.nodeCode)) {
        throw asDefinitive(err);
      }
      throw err;
    }
  }

  const offer = (row: OfferRowType): Offer => ({
    id: row.offer_id,
    bolt12: row.bolt12,
    ...(row.description === undefined ? {} : { description: untrustedText(row.description) }),
    ...(row.label === undefined ? {} : { label: untrustedText(row.label) }),
    active: row.active,
    singleUse: row.single_use,
    used: row.used,
  });

  const adapter = {
    implementation: 'cln' as const,
    node: {
      async getInfo(): Promise<NodeFacts> {
        const reply = await info();
        return {
          pubkey: parsePubkey(reply.id),
          alias: untrustedText(reply.alias ?? ''),
          color: reply.color,
          implementation: 'cln',
          version: reply.version,
          network: NETWORKS[reply.network] ?? 'unknown',
          networkRaw: reply.network,
          blockHeight: reply.blockheight,
          synced: reply.warning_bitcoind_sync === undefined && reply.warning_lightningd_sync === undefined,
          numPeers: reply.num_peers,
          numActiveChannels: reply.num_active_channels,
          numPendingChannels: reply.num_pending_channels,
          numInactiveChannels: reply.num_inactive_channels,
          features: reply.our_features.init,
          addresses: announced(reply.address ?? []),
        };
      },
      checkRune: async (rune: string, method: string, params?: Record<string, string>) => {
        try {
          const result = await call('checkrune', { rune, method, ...(params ? { params } : {}) });
          return parse(CheckRune, result).valid;
        } catch (error) {
          if (
            error instanceof AdapterError &&
            error.code === 'node_error' &&
            [1501, 1502, 1503].includes(error.nodeCode ?? 0)
          )
            return false;
          throw error;
        }
      },
      getStatus: () => getStatus({ call, viewRune: options.viewRune, spendRune: options.spendRune, lastSeen }),
    },
    chain: {
      async getTipHeader() {
        return blockAt((await info()).blockheight);
      },
      getHeaderAt: (height: number) => {
        if (!Number.isInteger(height) || height < 0) throw invalidRequest('height');
        return blockAt(height);
      },
      async getFeeEstimates() {
        const { perkb } = parse(Feerates, await call('feerates', { style: 'perkb' }));
        const estimates = [...(perkb.estimates ?? [])].sort((a, b) => a.blockcount - b.blockcount);
        const within = (blocks: number) =>
          [...estimates].reverse().find((e) => e.blockcount <= blocks)?.feerate ?? estimates[0]?.feerate;
        const rate = (value: number | undefined) => perkbToSatPerVbyte(value ?? perkb.min_acceptable);
        return {
          source: 'node' as const,
          at: new Date().toISOString(),
          rates: {
            fastest: rate(estimates[0]?.feerate),
            halfHour: rate(within(3)),
            hour: rate(within(6)),
            economy: rate(estimates.at(-1)?.feerate),
            minimum: rate(perkb.min_acceptable),
          },
          node: {
            ...(perkb.opening === undefined ? {} : { opening: rate(perkb.opening) }),
            ...(perkb.mutual_close === undefined ? {} : { mutualClose: rate(perkb.mutual_close) }),
            ...(perkb.unilateral_close === undefined ? {} : { unilateralClose: rate(perkb.unilateral_close) }),
          },
        };
      },
      async isSynced() {
        const reply = await info();
        if (reply.warning_bitcoind_sync !== undefined || reply.warning_lightningd_sync !== undefined) return false;
        const chain = parse(GetChainInfo, await call('getchaininfo', { last_height: reply.blockheight }));
        return !chain.ibd && chain.headercount === chain.blockcount && chain.blockcount === reply.blockheight;
      },
    },
    balance: {
      async getBalances(): Promise<Balances> {
        const funds = parse(ListFunds, await call('listfunds', {}));
        const peers = parse(ListPeerChannels, await call('listpeerchannels', {}));
        const sum = (values: Msat[]) => add(...values);
        const unspent = funds.outputs.filter((o) => o.status !== 'spent');
        const free = unspent.filter((o) => !o.reserved);
        const open = peers.channels.filter((c) => OPEN_STATES.has(c.state));
        return {
          onchain: {
            confirmed: sum(free.filter((o) => o.status === 'confirmed').map((o) => msat(o.amount_msat))),
            unconfirmed: sum(free.filter((o) => o.status === 'unconfirmed').map((o) => msat(o.amount_msat))),
            reserved: sum(unspent.filter((o) => o.reserved).map((o) => msat(o.amount_msat))),
          },
          lightning: {
            local: sum(open.map((c) => msat(c.to_us_msat ?? 0n))),
            // Nothing can be sent or received through a channel whose peer is offline.
            spendable: sum(open.filter((c) => c.peer_connected).map((c) => msat(c.spendable_msat ?? 0n))),
            remote: sum(open.map((c) => sub(msat(c.total_msat ?? 0n), msat(c.to_us_msat ?? 0n)))),
            receivable: sum(open.filter((c) => c.peer_connected).map((c) => msat(c.receivable_msat ?? 0n))),
          },
          pendingClose: sum(
            peers.channels.filter((c) => CLOSING_STATES.has(c.state)).map((c) => msat(c.to_us_msat ?? 0n)),
          ),
        };
      },
    },
    peer: {
      async listPeers() {
        const { peers } = parse(ListPeers, await call('listpeers', {}));
        const names = await aliasesOf(peers.map((p) => p.id));
        return peers.map((p) => {
          const alias = names.get(p.id);
          return {
            pubkey: parsePubkey(p.id),
            ...(alias === undefined ? {} : { alias }),
            connected: p.connected,
            addresses: p.netaddr ?? [],
            ...(p.features === undefined ? {} : { features: p.features }),
            numChannels: p.num_channels ?? 0,
          };
        });
      },
      async connect(uri: string) {
        let target;
        try {
          target = decodeNodeUri(uri);
        } catch (err) {
          if (err instanceof DecodeError) throw invalidRequest('node URI');
          throw err;
        }
        const reply = parse(
          Connect,
          await call('connect', {
            id: target.pubkey,
            ...(target.host === undefined ? {} : { host: target.host }),
            ...(target.port === undefined ? {} : { port: target.port }),
          }),
        );
        aliases.delete(reply.id);
        return { pubkey: parsePubkey(reply.id) };
      },
      async disconnect(pubkey: Pubkey, disconnectOptions?: { force?: boolean }) {
        await call('disconnect', { id: pubkey, force: disconnectOptions?.force === true });
      },
    },
    channel: {
      async listChannels(page?: { cursor?: string; limit?: number }) {
        checkOffsetPage(page);
        const { channels } = parse(ListPeerChannels, await call('listpeerchannels', {}));
        const result = offsetPage(channels, page);
        const names = await aliasesOf(result.items.map((c) => c.peer_id));
        return {
          ...result,
          items: result.items.flatMap((c) => {
            const mapped = channel(c, names.get(c.peer_id));
            return mapped ? [mapped] : [];
          }),
        };
      },
      async listClosedChannels(page?: { cursor?: string; limit?: number }) {
        checkOffsetPage(page);
        const { closedchannels } = parse(ListClosedChannels, await call('listclosedchannels', {}));
        const result = offsetPage(closedchannels, page);
        const names = await aliasesOf(result.items.flatMap((c) => (c.peer_id ? [c.peer_id] : [])));
        return {
          ...result,
          items: result.items.map((c) => closedChannel(c, c.peer_id === undefined ? undefined : names.get(c.peer_id))),
        };
      },
      async listHtlcs(page?: { cursor?: string; limit?: number }, id?: string) {
        const limit = pageLimit(page);
        const { htlcs } = parse(
          ListHtlcs,
          await call('listhtlcs', {
            ...(id === undefined ? {} : { id }),
            index: 'created',
            start: cursorStart(page, 'i'),
            limit: limit + 1,
          }),
        );
        return indexPage(htlcs, limit, (h): Htlc => ({
          shortChannelId: h.short_channel_id as Htlc['shortChannelId'],
          direction: h.direction,
          amount: msat(h.amount_msat),
          paymentHash: parsePaymentHash(h.payment_hash),
          expiry: h.expiry,
          state: h.state,
          // An HTLC is gone from the channel once its removal has been acknowledged by both sides.
          inFlight: !h.state.endsWith('_REMOVE_ACK_REVOCATION'),
        }));
      },
      async openChannel(request: {
        peer: Pubkey;
        amount: Msat | 'all';
        feeRate?: string;
        announce?: boolean;
        pushMsat?: Msat;
        minConf?: number;
      }) {
        const params = {
          id: request.peer,
          amount: request.amount === 'all' ? 'all' : wholeSats(request.amount),
          ...(request.feeRate === undefined ? {} : { feerate: satPerVbyteToPerkb(request.feeRate) }),
          ...(request.announce === undefined ? {} : { announce: request.announce }),
          ...(request.pushMsat === undefined ? {} : { push_msat: request.pushMsat }),
          ...(request.minConf === undefined ? {} : { minconf: request.minConf }),
        };
        const reply = parse(
          FundChannel,
          await fundError(() => call('fundchannel', params, { timeoutMs: channelTimeoutMs })),
        );
        return { channelId: parseChannelId(reply.channel_id), txid: parseTxid(reply.txid), outnum: reply.outnum };
      },
      async closeChannel(request: {
        channel: string;
        force: boolean;
        destination?: string;
      }): Promise<CloseChannelResult> {
        // CLN's default unilateraltimeout (two days) turns a cooperative close into a force close by itself; 0 waits
        // for the peer indefinitely. A force close publishes after 1 s (reference pass, C4).
        const params = {
          id: request.channel,
          unilateraltimeout: request.force ? 1 : 0,
          ...(request.destination === undefined ? {} : { destination: request.destination }),
        };
        let reply;
        try {
          reply = parse(Close, await call('close', params, { timeoutMs: channelTimeoutMs }));
        } catch (err) {
          // The node took the request and goes on closing; the channel state shows the rest.
          if (err instanceof AdapterError && err.sent && err.detail === 'timeout') return { type: 'pending' };
          throw err;
        }
        if (reply.type === 'unopened') return { type: 'unopened' };
        if (reply.type === 'mutual' || reply.type === 'unilateral') {
          return { type: reply.type, txids: (reply.txids ?? []).map(parseTxid) };
        }
        return { type: 'pending' };
      },
      async setPolicy(request: {
        channel: string;
        baseFeeMsat?: Msat;
        feePpm?: number;
        minHtlcMsat?: Msat;
        maxHtlcMsat?: Msat;
      }) {
        await call('setchannel', {
          id: request.channel,
          ...(request.baseFeeMsat === undefined ? {} : { feebase: request.baseFeeMsat }),
          ...(request.feePpm === undefined ? {} : { feeppm: request.feePpm }),
          ...(request.minHtlcMsat === undefined ? {} : { htlcmin: request.minHtlcMsat }),
          ...(request.maxHtlcMsat === undefined ? {} : { htlcmax: request.maxHtlcMsat }),
        });
      },
    },
    receive: {
      async createInvoice(request: {
        amount?: Msat;
        description: string;
        label: string;
        expirySeconds?: number;
        exposePrivateChannels?: boolean;
      }) {
        const reply = parse(
          InvoiceReply,
          await call('invoice', {
            amount_msat: request.amount ?? 'any',
            label: request.label,
            description: request.description,
            ...(request.expirySeconds === undefined ? {} : { expiry: request.expirySeconds }),
            // Left to the node's default unless the owner chose otherwise (reference pass, decision 4).
            ...(request.exposePrivateChannels === undefined
              ? {}
              : { exposeprivatechannels: request.exposePrivateChannels }),
          }),
        );
        return {
          paymentHash: parsePaymentHash(reply.payment_hash),
          bolt11: reply.bolt11,
          ...(request.amount === undefined ? {} : { amount: request.amount }),
          description: untrustedText(request.description),
          label: request.label,
          status: 'unpaid' as const,
          createdAt: new Date().toISOString(),
          expiresAt: isoFromSeconds(reply.expires_at),
        };
      },
      async listInvoices(page?: { cursor?: string; limit?: number }) {
        const limit = pageLimit(page);
        const { invoices } = parse(
          ListInvoices,
          await call('listinvoices', { index: 'created', start: cursorStart(page, 'i'), limit: limit + 1 }),
        );
        return indexPage(invoices, limit, invoice);
      },
      async getInvoice(paymentHash: string) {
        const { invoices } = parse(ListInvoices, await call('listinvoices', { payment_hash: paymentHash }));
        const row = invoices.find((i) => i.payment_hash === paymentHash);
        return row === undefined ? undefined : invoice(row);
      },
      async newAddress(type: 'p2wpkh' | 'p2tr') {
        const reply = parse(NewAddr, await call('newaddr', { addresstype: type === 'p2tr' ? 'p2tr' : 'bech32' }));
        const address = type === 'p2tr' ? reply.p2tr : reply.bech32;
        if (address === undefined) {
          throw new AdapterError({ code: 'node_bad_response', sent: true, definitive: false, detail: 'no address' });
        }
        return { address, type, createdAt: new Date().toISOString() };
      },
      async createOffer(request: { amount?: Msat; description: string; label?: string; singleUse?: boolean }) {
        const reply = parse(
          OfferRow,
          await call('offer', {
            amount: request.amount === undefined ? 'any' : `${request.amount}msat`,
            description: request.description,
            ...(request.label === undefined ? {} : { label: request.label }),
            ...(request.singleUse === undefined ? {} : { single_use: request.singleUse }),
          }),
        );
        return {
          ...offer(reply),
          ...(request.amount === undefined ? {} : { amount: request.amount }),
          description: untrustedText(request.description),
        };
      },
      async listOffers() {
        return parse(ListOffers, await call('listoffers', {})).offers.map(offer);
      },
      async disableOffer(id: string) {
        if (!/^[0-9a-f]{64}$/.test(id)) throw invalidRequest('offer id');
        return offer(parse(OfferRow, await call('disableoffer', { offer_id: id })));
      },
    },
    pay: {
      async decode(text: string) {
        const reply = parse(Decode, await call('decode', { string: text }));
        const amount = reply.amount_msat ?? reply.invoice_amount_msat ?? reply.offer_amount_msat;
        const payee = reply.payee ?? reply.invoice_node_id ?? reply.offer_issuer_id;
        const hash = reply.payment_hash ?? reply.invoice_payment_hash;
        const description = reply.description ?? reply.offer_description;
        return {
          type: reply.type,
          valid: reply.valid,
          ...(amount === undefined ? {} : { amount: msat(amount) }),
          ...(payee === undefined ? {} : { payee: parsePubkey(payee) }),
          ...(hash === undefined ? {} : { paymentHash: parsePaymentHash(hash) }),
          ...(description === undefined ? {} : { description: untrustedText(description) }),
        };
      },
      async previewRoute(request: { destination: Pubkey; amount: Msat; maxFee: Msat; finalCltv: number }) {
        const source = ownId ?? parsePubkey((await info()).id);
        let reply;
        try {
          reply = parse(
            GetRoutes,
            await call('getroutes', {
              source,
              destination: request.destination,
              amount_msat: request.amount,
              // The node's own channels, and no fee for the first hop (it is ours).
              layers: ['auto.localchans', 'auto.sourcefree'],
              maxfee_msat: request.maxFee,
              final_cltv: request.finalCltv,
            }),
          );
        } catch (err) {
          // askrene answers "no route" with a node error; the preview then has no route, which is not a failure.
          if (err instanceof AdapterError && err.code === 'node_error' && err.nodeCode !== undefined) return undefined;
          throw err;
        }
        if (reply.routes.length === 0) return undefined;
        const sent = reply.routes.reduce((total, r) => total + (r.path[0]?.amount_msat ?? r.amount_msat), 0n);
        const delivered = reply.routes.reduce((total, r) => total + r.amount_msat, 0n);
        return {
          fee: msat(sent >= delivered ? sent - delivered : 0n),
          hops: Math.max(...reply.routes.map((r) => r.path.length)),
          probabilityPpm: reply.probability_ppm,
        };
      },
      async fetchOfferInvoice(offerText: string, amount?: Msat) {
        const reply = parse(
          FetchInvoice,
          await call('fetchinvoice', { offer: offerText, ...(amount === undefined ? {} : { amount_msat: amount }) }),
        );
        return reply.invoice;
      },
      async listPayments(page?: { cursor?: string; limit?: number }) {
        const limit = pageLimit(page);
        const { pays } = parse(
          ListPays,
          await call('listpays', { index: 'created', start: cursorStart(page, 'i'), limit: limit + 1 }),
        );
        return indexPage(pays, limit, payment);
      },
      getPayment,
      listByLabel,
      async pay(request: { bolt11: string; amount?: Msat; maxFee: Msat; label: string; retryForSeconds: number }) {
        const params = {
          invstring: request.bolt11,
          ...(request.amount === undefined ? {} : { amount_msat: request.amount }),
          maxfee: request.maxFee,
          retry_for: request.retryForSeconds,
          label: request.label,
        };
        let paymentHash: string | undefined;
        try {
          paymentHash = readBolt11(request.bolt11).paymentHash;
        } catch {
          paymentHash = undefined;
        }
        try {
          // xpay returns when it gives up (retry_for), so the timeout leaves room beyond that.
          return payResult(
            parse(XpayReply, await call('xpay', params, { timeoutMs: (request.retryForSeconds + 30) * 1000 })),
          );
        } catch (err) {
          if (paymentHash !== undefined) {
            const earlier = await alreadyPaid(err, paymentHash);
            if (earlier) return earlier;
          }
          throw await classifyPayError(err, async () => {
            if (paymentHash === undefined) throw err;
            const record = await getPayment(paymentHash);
            return record ? [record] : [];
          });
        }
      },
      async keysend(request: {
        destination: Pubkey;
        amount: Msat;
        maxFee: Msat;
        label: string;
        retryForSeconds: number;
      }) {
        const params = {
          destination: request.destination,
          amount_msat: request.amount,
          maxfee: request.maxFee,
          retry_for: request.retryForSeconds,
          label: request.label,
        };
        try {
          return payResult(
            parse(XpayReply, await call('xkeysend', params, { timeoutMs: (request.retryForSeconds + 30) * 1000 })),
          );
        } catch (err) {
          // The node makes the preimage, so the payment hash is unknown: our label finds its parts (spend policy §4).
          throw await classifyPayError(err, () => listByLabel(request.label));
        }
      },
    },
    onchain: {
      listTransactions: (page?: { cursor?: string; limit?: number }) => listTransactions(call, page),
      async listUtxos(): Promise<Utxo[]> {
        const { outputs } = parse(ListFunds, await call('listfunds', {}));
        const STATUSES = new Set(['unconfirmed', 'confirmed', 'spent', 'immature']);
        return outputs.map((o) => ({
          outpoint: `${o.txid}:${o.output}` as Utxo['outpoint'],
          amount: msat(o.amount_msat),
          ...(o.address === undefined ? {} : { address: o.address }),
          status: (STATUSES.has(o.status) ? o.status : 'unknown') as Utxo['status'],
          reserved: o.reserved === true,
          ...(o.blockheight === undefined ? {} : { blockHeight: o.blockheight }),
        }));
      },
      async prepare(request: {
        outputs: { address: string; amount: Msat | 'all' }[];
        feeRate?: string;
        minConf?: number;
        utxos?: string[];
      }) {
        if (request.outputs.length === 0) throw invalidRequest('no outputs');
        if (request.outputs.some((o) => o.amount === 'all') && request.outputs.length > 1) {
          throw invalidRequest('"all" must be the only output');
        }
        const params = {
          outputs: request.outputs.map((o) => ({
            [o.address]: o.amount === 'all' ? 'all' : `${wholeSats(o.amount)}sat`,
          })),
          ...(request.feeRate === undefined ? {} : { feerate: satPerVbyteToPerkb(request.feeRate) }),
          ...(request.minConf === undefined ? {} : { minconf: request.minConf }),
          ...(request.utxos === undefined ? {} : { utxos: request.utxos }),
        };
        // txprepare reserves inputs and broadcasts nothing.
        const reply = parse(TxPrepare, await fundError(() => call('txprepare', params)));
        return { txid: parseTxid(reply.txid), psbt: reply.psbt };
      },
      async send(txid: string) {
        return { txid: parseTxid(parse(TxSend, await call('txsend', { txid })).txid) };
      },
      async discard(txid: string) {
        await call('txdiscard', { txid });
      },
      async unreserve(psbt: string) {
        await call('unreserveinputs', { psbt });
      },
    },
    routing: {
      async listForwards(page?: { cursor?: string; limit?: number }) {
        const limit = pageLimit(page);
        const { forwards } = parse(
          ListForwards,
          await call('listforwards', { index: 'created', start: cursorStart(page, 'i'), limit: limit + 1 }),
        );
        return indexPage(forwards, limit, forward);
      },
    },
    events: {
      subscribe: (cursor?: string, signal?: AbortSignal) => subscribe(call, cursor, signal),
    },
    plugin: {
      async listPlugins() {
        const { plugins } = parse(PluginList, await call('plugin', { subcommand: 'list' }));
        return plugins.map((p) => ({ name: p.name.split('/').at(-1) ?? p.name, active: p.active }));
      },
    },
  } satisfies NodeAdapter;

  return adapter;
}
