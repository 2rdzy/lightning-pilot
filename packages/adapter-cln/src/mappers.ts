// CLN rows → domain types. Node text (aliases, descriptions, labels) goes through untrustedText; ids through the
// core parsers, so a malformed id from the node fails here instead of travelling on.
import {
  AdapterError,
  msat,
  parseChannelId,
  parseFundingOutpoint,
  parsePaymentHash,
  parsePubkey,
  parseShortChannelId,
  sub,
  untrustedText,
  ZERO,
  type Channel,
  type ClosedChannel,
  type Forward,
  type ForwardStatus,
  type Invoice,
  type Msat,
  type Payment,
  type PaymentStatus,
  type UntrustedText,
} from '@lightning-pilot/core';
import { isoFromSeconds } from './context.ts';
import type { ClosedChannelRow, ForwardRow, InvoiceRow, PayRow, PeerChannel } from './schemas.ts';
import { channelState, closeCause } from './states.ts';

const FORWARD_STATUSES: Record<string, ForwardStatus> = {
  settled: 'settled',
  failed: 'failed',
  local_failed: 'local_failed',
  offered: 'offered',
};

export function forward(row: ForwardRow): Forward {
  return {
    inChannel: parseShortChannelId(row.in_channel),
    ...(row.out_channel === undefined ? {} : { outChannel: parseShortChannelId(row.out_channel) }),
    amountIn: msat(row.in_msat),
    ...(row.out_msat === undefined ? {} : { amountOut: msat(row.out_msat) }),
    ...(row.fee_msat === undefined ? {} : { fee: msat(row.fee_msat) }),
    status: FORWARD_STATUSES[row.status] ?? 'unknown',
    statusRaw: row.status,
    receivedAt: isoFromSeconds(row.received_time),
    ...(row.resolved_time === undefined ? {} : { resolvedAt: isoFromSeconds(row.resolved_time) }),
    ...(row.failcode === undefined ? {} : { failCode: row.failcode }),
  };
}

const INVOICE_STATUSES = new Set(['unpaid', 'paid', 'expired']);

export function invoice(row: InvoiceRow): Invoice {
  if (!INVOICE_STATUSES.has(row.status)) {
    throw new AdapterError({ code: 'node_bad_response', sent: true, definitive: false, detail: 'invoice status' });
  }
  return {
    paymentHash: parsePaymentHash(row.payment_hash),
    bolt11: row.bolt11 ?? '',
    ...(row.amount_msat === undefined ? {} : { amount: msat(row.amount_msat) }),
    ...(row.amount_received_msat === undefined ? {} : { amountReceived: msat(row.amount_received_msat) }),
    description: untrustedText(row.description ?? ''),
    label: untrustedText(row.label),
    status: row.status as Invoice['status'],
    expiresAt: isoFromSeconds(row.expires_at),
    ...(row.paid_at === undefined ? {} : { paidAt: isoFromSeconds(row.paid_at) }),
    ...(row.status === 'paid' && row.payment_preimage ? { preimage: row.payment_preimage } : {}),
  };
}

const PAY_STATUSES: Record<string, PaymentStatus> = { pending: 'pending', complete: 'succeeded', failed: 'failed' };

export function payment(row: PayRow): Payment {
  const status = PAY_STATUSES[row.status];
  if (!status)
    throw new AdapterError({ code: 'node_bad_response', sent: true, definitive: false, detail: 'pay status' });
  const amount = row.amount_msat;
  const sent = row.amount_sent_msat;
  return {
    paymentHash: parsePaymentHash(row.payment_hash),
    status,
    ...(row.destination === undefined ? {} : { destination: parsePubkey(row.destination) }),
    ...(amount === undefined ? {} : { amount: msat(amount) }),
    ...(sent === undefined ? {} : { amountSent: msat(sent) }),
    ...(amount !== undefined && sent !== undefined && sent >= amount ? { fee: sub(msat(sent), msat(amount)) } : {}),
    createdAt: isoFromSeconds(row.created_at),
    ...(row.completed_at === undefined ? {} : { completedAt: isoFromSeconds(row.completed_at) }),
    ...(row.preimage === undefined ? {} : { preimage: row.preimage }),
    ...(row.label === undefined ? {} : { label: row.label }),
    ...(row.number_of_parts === undefined ? {} : { parts: row.number_of_parts }),
  };
}

const m = (value: bigint | undefined): Msat => msat(value ?? 0n);

// A channel without a channel id or funding outpoint (an open still being negotiated) has nothing to show yet and
// is left out.
export function channel(row: PeerChannel, alias: UntrustedText | undefined): Channel | undefined {
  if (row.channel_id === undefined || row.funding_txid === undefined || row.funding_outnum === undefined)
    return undefined;
  const capacity = m(row.total_msat);
  const local = m(row.to_us_msat);
  const policy = row.updates?.local;
  return {
    id: parseChannelId(row.channel_id),
    ...(row.short_channel_id === undefined ? {} : { shortChannelId: parseShortChannelId(row.short_channel_id) }),
    peer: { pubkey: parsePubkey(row.peer_id), ...(alias === undefined ? {} : { alias }) },
    state: channelState(row.state, row.peer_connected === true),
    opener: row.opener === 'remote' ? 'remote' : 'local',
    private: row.private === true,
    capacity,
    local,
    remote: capacity >= local ? sub(capacity, local) : ZERO,
    spendable: m(row.spendable_msat),
    receivable: m(row.receivable_msat),
    reserves: { ours: m(row.our_reserve_msat), theirs: m(row.their_reserve_msat) },
    fundingOutpoint: parseFundingOutpoint(`${row.funding_txid}:${row.funding_outnum}`),
    ...(policy === undefined
      ? {}
      : {
          policy: {
            baseFeeMsat: msat(policy.fee_base_msat),
            feePpm: policy.fee_proportional_millionths,
            minHtlcMsat: msat(policy.htlc_minimum_msat),
            maxHtlcMsat: msat(policy.htlc_maximum_msat),
            cltvDelta: policy.cltv_expiry_delta,
          },
        }),
    channelType: row.channel_type?.names ?? [],
    ...(row.close_to_addr === undefined ? {} : { closeTo: row.close_to_addr }),
    stats: {
      inFulfilled: m(row.in_fulfilled_msat),
      outFulfilled: m(row.out_fulfilled_msat),
      inPayments: row.in_payments_fulfilled ?? 0,
      outPayments: row.out_payments_fulfilled ?? 0,
    },
  };
}

export function closedChannel(row: ClosedChannelRow, alias: UntrustedText | undefined): ClosedChannel {
  return {
    id: parseChannelId(row.channel_id),
    ...(row.short_channel_id === undefined ? {} : { shortChannelId: parseShortChannelId(row.short_channel_id) }),
    ...(row.peer_id === undefined
      ? {}
      : { peer: { pubkey: parsePubkey(row.peer_id), ...(alias === undefined ? {} : { alias }) } }),
    capacity: msat(row.total_msat),
    finalLocal: msat(row.final_to_us_msat),
    closeCause: closeCause(row.close_cause),
    closeCauseRaw: row.close_cause,
    fundingOutpoint: parseFundingOutpoint(`${row.funding_txid}:${row.funding_outnum}`),
  };
}
