// Core Lightning adapter (minimal): node info, the chain tip, balances, invoices and BOLT11 payments over clnrest.
// Every command it sends is in the method table (methods.ts), with the credential that table names.
import { createHash } from 'node:crypto';
import {
  AdapterError,
  add,
  msat,
  parsePaymentHash,
  parsePubkey,
  readBolt11,
  sub,
  untrustedText,
  ZERO,
  type Balances,
  type Msat,
  type Network,
  type NodeAdapter,
  type NodeFacts,
  type Payment,
} from '@lightning-pilot/core';
import type { z } from 'zod';
import { ClnRestClient } from './client.ts';
import { METHODS, type ClnMethod } from './methods.ts';
import { GetInfo, InvoiceReply, ListFunds, ListPeerChannels, ListSendPays, RawBlock, XpayReply } from './schemas.ts';

export interface ClnAdapterOptions {
  url: string;
  caCertificate: string;
  serverName: string;
  viewRune: string;
  spendRune?: string;
  readTimeoutMs?: number;
  // Observes every command sent (tests use it to prove the adapter calls only what the method table lists).
  onCall?: (command: string, credential: 'read' | 'spend') => void;
  // Replaces the HTTPS client; unit tests use it to play recorded node replies.
  transport?: Transport;
}

export type Transport = Pick<ClnRestClient, 'call'>;

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

// xpay failures after which the node made no payment, once listsendpays confirms that no part is pending or
// complete: -32602 invalid parameters (refused before xpay does anything, e.g. an invoice the node cannot parse),
// 203 destination permanent failure, 205 route not found, 207 invoice expired, 210 stopped retrying, 212 invoice
// request invalid. Any other code is not definitive (CLN common/jsonrpc_errors.h).
const PAY_NOT_MADE = new Set([-32602, 203, 205, 207, 210, 212]);

const credentialOf = (command: ClnMethod) =>
  METHODS.find((row) => (row.nodeMethods as readonly string[]).includes(command))?.credential;

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AdapterError({ code: 'node_bad_response', sent: true, definitive: false, detail: result.error.message });
  }
  return result.data;
}

const preimageHash = (preimage: string) =>
  parsePaymentHash(createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex'));

export function createClnAdapter(options: ClnAdapterOptions): NodeAdapter {
  const client: Transport =
    options.transport ??
    new ClnRestClient({ url: options.url, caCertificate: options.caCertificate, serverName: options.serverName });
  const readTimeoutMs = options.readTimeoutMs ?? 30_000;

  // The rune is chosen from the method table, never by the caller: a read command can only go out with the view
  // rune and a spend command only with the spend rune.
  async function call(command: ClnMethod, params: Record<string, unknown>, timeoutMs = readTimeoutMs) {
    const credential = credentialOf(command);
    if (credential !== 'read' && credential !== 'spend') throw new Error(`${command} is not in the method table`);
    const rune = credential === 'spend' ? options.spendRune : options.viewRune;
    if (!rune) throw new AdapterError({ code: 'permission_denied', sent: false, definitive: true });
    options.onCall?.(command, credential);
    return client.call(command, params, { rune, timeoutMs });
  }

  async function getInfo(): Promise<NodeFacts> {
    const info = parse(GetInfo, await call('getinfo', {}));
    return {
      pubkey: parsePubkey(info.id),
      alias: untrustedText(info.alias ?? ''),
      color: info.color,
      implementation: 'cln',
      version: info.version,
      network: NETWORKS[info.network] ?? 'unknown',
      networkRaw: info.network,
      blockHeight: info.blockheight,
      synced: info.warning_bitcoind_sync === undefined && info.warning_lightningd_sync === undefined,
      numPeers: info.num_peers,
      numActiveChannels: info.num_active_channels,
      numPendingChannels: info.num_pending_channels,
      numInactiveChannels: info.num_inactive_channels,
      features: info.our_features.init,
    };
  }

  async function getPayment(paymentHash: string): Promise<Payment | undefined> {
    const reply = parse(ListSendPays, await call('listsendpays', { payment_hash: paymentHash }));
    const parts = reply.payments.filter((p) => p.payment_hash === paymentHash);
    if (parts.length === 0) return undefined;
    const complete = parts.filter((p) => p.status === 'complete');
    const status = complete.length > 0 ? 'succeeded' : parts.some((p) => p.status === 'pending') ? 'pending' : 'failed';
    // An unknown part status is never read as "failed": only explicit failures count.
    if (status === 'failed' && parts.some((p) => p.status !== 'failed')) {
      return { paymentHash: parsePaymentHash(paymentHash), status: 'pending' };
    }
    const preimage = complete.find((p) => p.payment_preimage)?.payment_preimage;
    const label = parts.find((p) => p.label)?.label;
    return {
      paymentHash: parsePaymentHash(paymentHash),
      status,
      ...(complete.length > 0 ? { amountSent: add(...complete.map((p) => msat(p.amount_sent_msat ?? 0n))) } : {}),
      ...(preimage ? { preimage } : {}),
      ...(label ? { label } : {}),
    };
  }

  return {
    implementation: 'cln',
    node: { getInfo },
    chain: {
      async getTipHeader() {
        const info = parse(GetInfo, await call('getinfo', {}));
        const block = parse(RawBlock, await call('getrawblockbyheight', { height: info.blockheight }));
        return { height: info.blockheight, raw: block.block };
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
    receive: {
      async createInvoice(request) {
        const reply = parse(
          InvoiceReply,
          await call('invoice', {
            amount_msat: request.amount,
            label: request.label,
            description: request.description,
            ...(request.expirySeconds === undefined ? {} : { expiry: request.expirySeconds }),
          }),
        );
        return {
          paymentHash: parsePaymentHash(reply.payment_hash),
          bolt11: reply.bolt11,
          amount: request.amount,
          description: untrustedText(request.description),
          label: request.label,
          status: 'unpaid',
          expiresAt: new Date(reply.expires_at * 1000).toISOString(),
        };
      },
    },
    pay: {
      getPayment,
      async pay(request) {
        const params = {
          invstring: request.bolt11,
          maxfee: request.maxFee,
          retry_for: request.retryForSeconds,
          label: request.label,
        };
        let reply;
        try {
          // xpay returns when it gives up (retry_for), so the timeout leaves room beyond that.
          reply = parse(XpayReply, await call('xpay', params, (request.retryForSeconds + 30) * 1000));
        } catch (err) {
          throw await classifyPayError(err, request.bolt11);
        }
        const fee =
          reply.amount_sent_msat >= reply.amount_msat
            ? sub(msat(reply.amount_sent_msat), msat(reply.amount_msat))
            : ZERO;
        return {
          paymentHash: preimageHash(reply.payment_preimage),
          preimage: reply.payment_preimage,
          amount: msat(reply.amount_msat),
          amountSent: msat(reply.amount_sent_msat),
          fee,
        };
      },
    },
  };

  // Only a node reply that clearly says nothing was paid, confirmed by the node's own payment records, is
  // definitive. Everything else stays "not definitive" so the spend is recorded as unknown, never as failed.
  async function classifyPayError(err: unknown, bolt11: string): Promise<unknown> {
    if (!(err instanceof AdapterError) || err.nodeCode === undefined || !err.sent) return err;
    if (!PAY_NOT_MADE.has(err.nodeCode)) return err;
    let paymentHash: string;
    try {
      paymentHash = readBolt11(bolt11).paymentHash;
    } catch {
      return err;
    }
    let record: Payment | undefined;
    try {
      record = await getPayment(paymentHash);
    } catch {
      return err;
    }
    if (record === undefined || record.status === 'failed') {
      return new AdapterError({
        code: 'payment_failed',
        sent: true,
        definitive: true,
        nodeCode: err.nodeCode,
        ...(err.detail === undefined ? {} : { detail: err.detail }),
      });
    }
    return err;
  }
}
