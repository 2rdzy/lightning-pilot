import { z } from 'zod';
import { SetupLimits } from './setup.ts';
import { MsatString } from './money.ts';
import { ChainIdentityResponse } from './api.ts';
import { PubkeySchema } from './ids.ts';
import { ADDRESS_TYPES } from './decode/address.ts';

export function limitsAreOrdered(
  limits: Pick<z.infer<typeof SetupLimits>, 'maxPerPayment' | 'max24h' | 'stepUpAbove'>,
): boolean {
  const { maxPerPayment, max24h, stepUpAbove } = limits;
  const cap = maxPerPayment ?? max24h;
  return (
    !(maxPerPayment !== null && max24h !== null && BigInt(maxPerPayment) > BigInt(max24h)) &&
    !(stepUpAbove !== null && cap !== null && BigInt(stepUpAbove) > BigInt(cap))
  );
}
export const SpendPolicy = SetupLimits.extend({
  maxFeeRateMode: z.enum(['refuse', 'step-up']).default('refuse'),
  maxFeeShareMode: z.enum(['refuse', 'step-up']).default('refuse'),
  maxRoutingFeeMode: z.enum(['refuse', 'step-up']).default('refuse'),
})
  .refine(limitsAreOrdered, 'The step-up threshold and per-payment limit must be within their applicable caps.')
  .meta({ id: 'SpendPolicy' });
export type SpendPolicy = z.infer<typeof SpendPolicy>;
export const SpendPolicyResponse = z
  .strictObject({
    policy: SpendPolicy.nullable(),
    usedMsat: MsatString,
    remainingMsat: MsatString.nullable(),
    scope: z.string(),
  })
  .meta({ id: 'SpendPolicyResponse' });

// On-chain and channel spends (WP09b). Same two-step protocol as payments: a preview returns the cost and a
// single-use confirmation token; execute takes the token, an Idempotency-Key and the duplicate acknowledgement
// (PaymentExecuteRequest). Amounts are msat strings; on-chain amounts must be whole satoshis.
const wholeSats = MsatString.refine((a) => a !== '0' && a.endsWith('000'), 'whole satoshis, more than zero');
// sat/vB with at most three decimals, as the policy's maxFeeRate.
export const FeeRateString = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$/)
  .refine((v) => Number(v) > 0, 'more than zero')
  .meta({ description: 'Fee rate in sat/vB, up to three decimals' });
const ChannelRef = z
  .string()
  .regex(/^([0-9a-f]{64}|[0-9]{1,8}x[0-9]{1,8}x[0-9]{1,5})$/)
  .meta({ description: 'Channel id (32 bytes, hex) or short channel id' });
const SpendPreviewCommon = {
  // Single-use, valid for two minutes, only for this session; the only way to execute this spend.
  confirmationToken: z.string(),
  cost: z.strictObject({ amount: MsatString, maxFee: MsatString, total: MsatString }),
  duplicateWarning: z.boolean(),
  stepUpRequired: z.boolean(),
  feeOverride: z.boolean(),
  scope: z.string(),
  chainIdentity: ChainIdentityResponse,
  expiresAt: z.iso.datetime(),
};

export const OnchainPreviewRequest = z
  .strictObject({
    address: z.string().trim().min(1).max(200),
    amount: wholeSats,
    // Absent: the node's estimate for the next blocks.
    feeRate: FeeRateString.optional(),
  })
  .meta({ id: 'OnchainPreviewRequest' });
export const OnchainPreviewResponse = z
  .strictObject({
    ...SpendPreviewCommon,
    address: z.string(),
    addressType: z.enum(ADDRESS_TYPES),
    amount: MsatString,
    feeRate: FeeRateString,
  })
  .meta({ id: 'OnchainPreview' });

export const ChannelOpenPreviewRequest = z
  .strictObject({
    peer: PubkeySchema,
    amount: wholeSats,
    push: MsatString.optional(),
    feeRate: FeeRateString.optional(),
    announce: z.boolean().optional(),
  })
  .meta({ id: 'ChannelOpenPreviewRequest' });
export const ChannelOpenPreviewResponse = z
  .strictObject({
    ...SpendPreviewCommon,
    peer: PubkeySchema,
    amount: MsatString,
    push: MsatString,
    feeRate: FeeRateString,
  })
  .meta({ id: 'ChannelOpenPreview' });

export const ChannelClosePreviewRequest = z
  .strictObject({
    channel: ChannelRef,
    // A force close publishes our commitment at once and needs a fresh password step-up.
    force: z.boolean().default(false),
    // Absent: the node's own wallet (not counted against the limits).
    destination: z.string().trim().min(1).max(200).optional(),
  })
  .meta({ id: 'ChannelClosePreviewRequest' });
export const ChannelClosePreviewResponse = z
  .strictObject({
    ...SpendPreviewCommon,
    channel: ChannelRef,
    peer: PubkeySchema,
    force: z.boolean(),
    destination: z.string().optional(),
    localBalance: MsatString,
    // Where the funds go: the requested destination, else the channel's local shutdown address. `ownWallet` is true
    // only when that address is known to be the node's own; anything else is counted as an external close.
    fundsTo: z.strictObject({ address: z.string().min(1).max(200).optional(), ownWallet: z.boolean() }).optional(),
  })
  .meta({ id: 'ChannelClosePreview' });

export const SpendOutcomeResponse = z
  .strictObject({
    intentId: z.uuid(),
    state: z.enum(['succeeded', 'failed', 'unknown']),
    txid: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    channelId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    // Channel close: how the node closed it, or `pending` while it waits for the peer.
    closeType: z.enum(['mutual', 'unilateral', 'unopened', 'pending']).optional(),
  })
  .meta({ id: 'SpendOutcome' });

// Peer connection: a declared zero-cost action with the spend credential (spend policy §10).
export const PeerConnectRequest = z
  .strictObject({ uri: z.string().trim().min(66).max(300) })
  .meta({ id: 'PeerConnectRequest', description: 'pubkey@host:port, or a node public key' });
export const PeerConnectResponse = z.strictObject({ pubkey: PubkeySchema }).meta({ id: 'PeerConnected' });
export const PeerDisconnectRequest = z
  .strictObject({ force: z.boolean().default(false) })
  .meta({ id: 'PeerDisconnectRequest' });
export const PeerParam = z.strictObject({ nodeId: z.uuid(), pubkey: PubkeySchema });

// Spends whose outcome is not known (state `unknown`): recovery could not settle them from the node yet. The owner
// may resolve one by hand, with security step-up (spend policy §13). A wrong "failed" frees the budget it holds and,
// for a payment, lets the same invoice be paid again; `warning` is the text to show before that choice.
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const UnresolvedSpend = z
  .strictObject({
    intentId: z.uuid(),
    type: z.enum(['bolt11', 'onchain', 'channel-open', 'channel-close']),
    amount: MsatString,
    // What the spend counts against the limits while it is unresolved.
    cost: MsatString,
    destination: z.string().optional(),
    paymentHash: Hex64.optional(),
    txid: Hex64.optional(),
    channelId: Hex64.optional(),
    peer: PubkeySchema.optional(),
    // `interrupted`: the server stopped during the node call; otherwise the node's answer was unclear.
    reason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'UnresolvedSpend' });
export const UnresolvedSpendsResponse = z
  .strictObject({ items: z.array(UnresolvedSpend), warning: z.string() })
  .meta({ id: 'UnresolvedSpends' });
export const SpendIntentParam = z.strictObject({ nodeId: z.uuid(), intentId: z.uuid() });
export const SpendResolveRequest = z
  .strictObject({
    // `succeeded`: the funds left (keeps counting); `failed`: nothing left (frees the budget and the invoice).
    outcome: z.enum(['succeeded', 'failed']),
  })
  .meta({ id: 'SpendResolveRequest' });
export const SpendResolveResponse = z
  .strictObject({ intentId: z.uuid(), state: z.enum(['succeeded', 'failed']) })
  .meta({ id: 'SpendResolved' });
