import { z } from 'zod';
import {
  BalancesResponse,
  ChainIdentityResponse,
  Chain,
  Network,
  CHANNEL_STATE_GROUPS,
  FORWARD_STATUSES,
  ONCHAIN_TX_KINDS,
} from '@lightning-pilot/core';

const amount = z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const pubkey = z.string().regex(/^0[23][0-9a-f]{64}$/);
const text = z.string().max(4096);
const integer = z.number().int().nonnegative();
const rate = z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/);
export const EventNode = z.object({ chain: Chain, network: Network, pubkey });

// Server-local wire schemas: node money is serialized as decimal msat before validation. Object schemas strip
// extra fields so a new adapter field (notably a preimage or credential) cannot accidentally become public.
export const EVENT_SCHEMAS = {
  'invoice.paid': z.object({ paymentHash: hash, amountReceived: amount, label: text }),
  'invoice.expired': z.object({ paymentHash: hash, label: text.optional() }),
  'payment.updated': z.object({
    paymentHash: hash,
    status: z.enum(['pending', 'succeeded', 'failed']),
    amountSent: amount.optional(),
    fee: amount.optional(),
  }),
  'forward.updated': z.object({
    inChannel: text,
    outChannel: text.optional(),
    amountIn: amount,
    amountOut: amount.optional(),
    fee: amount.optional(),
    status: z.enum(FORWARD_STATUSES),
    statusRaw: text,
    receivedAt: text,
    resolvedAt: text.optional(),
    failCode: integer.optional(),
  }),
  'block.new': z.object({ height: integer }),
  'channel.updated': z.object({
    channelId: hash,
    state: z.object({ group: z.enum(CHANNEL_STATE_GROUPS), native: text, nativeLabel: text }),
    local: amount,
    remote: amount,
  }),
  'peer.updated': z.object({ pubkey, connected: z.boolean() }),
  'onchain.updated': z.object({
    txid: hash,
    amount: z.object({ direction: z.enum(['in', 'out']), value: amount }).optional(),
    fee: amount.optional(),
    blockHeight: integer.optional(),
    confirmations: integer,
    label: text.optional(),
    kind: z.enum(ONCHAIN_TX_KINDS),
  }),
  'balances.updated': BalancesResponse,
  'fees.updated': z.object({
    source: z.enum(['node', 'explorer']),
    at: text,
    rates: z.object({ fastest: rate, halfHour: rate, hour: rate, economy: rate, minimum: rate }),
    node: z
      .object({ opening: rate.optional(), mutualClose: rate.optional(), unilateralClose: rate.optional() })
      .optional(),
  }),
  'chain_identity.updated': ChainIdentityResponse,
  'node.reachability': z.object({ reachable: z.boolean(), credential: z.enum(['ok', 'revoked', 'missing']) }),
  reload: z.object({ reason: z.enum(['restart', 'history_lost', 'invalid_cursor', 'snapshot_changed']) }),
  'session.ending': z.object({ reason: z.enum(['logout', 'revoked', 'expired']) }),
} as const;
export type EventType = keyof typeof EVENT_SCHEMAS;
export type LiveEvent = {
  [K in EventType]: {
    id: string;
    type: K;
    at: string;
    node?: z.infer<typeof EventNode>;
    data: z.infer<(typeof EVENT_SCHEMAS)[K]>;
  };
}[EventType];

export function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as unknown;
}

// Consumers can render this reference instead of maintaining another hand-written list of event payloads.
export function eventDocumentation() {
  return Object.fromEntries(
    Object.entries(EVENT_SCHEMAS).map(([type, schema]) => [type, z.toJSONSchema(schema, { reused: 'inline' })]),
  );
}
