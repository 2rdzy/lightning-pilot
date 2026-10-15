// First-run API: each action advances one server-owned setup session. Secret values are returned only at enrolment.
import { z } from 'zod';
import { bech32 } from '@scure/base';
import { AddNodeRequest, Password, SessionResponse, ChainIdentityResponse } from './api.ts';

const sats = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const rate = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$/)
  .refine((v) => Number(v) > 0);
export const SetupLimits = z.strictObject({
  maxFeeRateMode: z.enum(['refuse', 'step-up']).optional(),
  maxFeeShareMode: z.enum(['refuse', 'step-up']).optional(),
  maxRoutingFeeMode: z.enum(['refuse', 'step-up']).optional(),
  maxPerPayment: sats.nullable(),
  max24h: sats.nullable(),
  stepUpAbove: sats.nullable(),
  maxFeeRate: rate,
  maxFeeSharePercent: z.int().min(1).max(100),
  maxRoutingFeeSharePercent: z.int().min(0).max(100),
  routingFeeAllowance: sats,
});
export type SetupLimits = z.infer<typeof SetupLimits>;
export const SetupAlerts = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('nostr'),
    recipient: z.string().refine((v) => {
      try {
        const decoded = bech32.decode(v as `${string}1${string}`);
        return decoded.prefix === 'npub' && bech32.fromWords(decoded.words).length === 32;
      } catch {
        return false;
      }
    }, 'a valid npub recipient'),
    relays: z
      .array(z.url({ protocol: /^wss$/ }))
      .min(1)
      .max(5),
  }),
  z.strictObject({ kind: z.literal('telegram'), botToken: z.string().regex(/^[0-9]{6,12}:[A-Za-z0-9_-]{35}$/) }),
]);
export type SetupAlerts = z.infer<typeof SetupAlerts>;
export const SetupAction = z
  .discriminatedUnion('action', [
    z.strictObject({ action: z.literal('start'), token: z.string().min(1).max(200) }),
    z.strictObject({ action: z.literal('password'), password: Password }),
    z.strictObject({ action: z.literal('totp'), code: z.string().regex(/^[0-9]{6}$/) }),
    z.strictObject({ action: z.literal('recovery'), code: z.string().min(1).max(64) }),
    z.strictObject({ action: z.literal('backup'), confirmed: z.literal(true) }),
    z.strictObject({ action: z.literal('node'), node: AddNodeRequest.nullable() }),
    z.strictObject({ action: z.literal('limits'), limits: SetupLimits }),
    z.strictObject({ action: z.literal('alerts'), alerts: SetupAlerts }),
    z.strictObject({ action: z.literal('complete') }),
    z.strictObject({ action: z.literal('cancel') }),
  ])
  .meta({ id: 'SetupAction' });
export type SetupAction = z.infer<typeof SetupAction>;
export const SETUP_STEPS = [
  'password',
  'totp',
  'recovery',
  'backup',
  'node',
  'limits',
  'alerts',
  'complete',
  'done',
  'cancelled',
] as const;
export const SetupProgress = z
  .strictObject({
    step: z.enum(SETUP_STEPS),
    csrfToken: z.string(),
    expiresAt: z.iso.datetime(),
    vaultKeyId: z.string(),
    tlsCertificate: z
      .strictObject({
        fingerprintSha256: z.string().regex(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/),
        expiresAt: z.iso.datetime(),
      })
      .optional(),
    secret: z.string().optional(),
    uri: z.string().optional(),
    recoveryCodes: z.array(z.string()).optional(),
    nodeIdentity: ChainIdentityResponse.optional(),
    feeEstimateAvailable: z.boolean().optional(),
    defaultLimits: SetupLimits.optional(),
    session: SessionResponse.optional(),
  })
  .meta({ id: 'SetupProgress' });
export type SetupProgress = z.infer<typeof SetupProgress>;

export const RecoveryEnrollment = z
  .strictObject({ secret: z.string(), uri: z.string() })
  .meta({ id: 'RecoveryEnrollment' });
export const RecoveryConfirm = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) }).meta({ id: 'RecoveryConfirm' });
