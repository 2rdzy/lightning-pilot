import { z } from 'zod';
import { AddNodeRequest } from './api.ts';
import { Chain } from './domain.ts';
import { PubkeySchema } from './ids.ts';
import { MsatString } from './money.ts';
import { SessionPolicy } from './sessions.ts';
import { SetupAlerts } from './setup.ts';
import { SpendPolicy } from './spend.ts';

export const EXPORT_RECORD_LIMITS = { nodes: 100, policies: 100, intents: 10000, restoreCounts: 1000 } as const;
export const EXPORT_PLAINTEXT_BYTES = 4 * 1024 * 1024;
export const EXPORT_FILE_BYTES = 6 * 1024 * 1024;
export const EXPORT_REQUEST_BYTES = 8 * 1024 * 1024;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.iso.datetime();
// Passphrases preserve exact UTF-8 bytes; account-password normalisation does not apply to files.
export const ExportPassphrase = z
  .string()
  .max(256)
  .refine((v) => {
    const n = Array.from(v).length;
    const bytes = new TextEncoder().encode(v);
    return (
      n >= 12 && n <= 128 && bytes.length <= 512 && new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) === v
    );
  }, 'Use 12 to 128 characters.');
const base64 = (max: number) =>
  z
    .string()
    .min(4)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((v) => v.length % 4 === 0);
export const ExportEnvelope = z
  .strictObject({
    format: z.literal('lightning-pilot-export'),
    version: z.literal(1),
    kdf: z.strictObject({
      name: z.literal('scrypt'),
      N: z.literal(131072),
      r: z.literal(8),
      p: z.literal(1),
      salt: base64(24),
    }),
    cipher: z.strictObject({ name: z.literal('aes-256-gcm'), nonce: base64(16), tag: base64(24) }),
    ciphertext: base64(5592408),
  })
  .meta({ id: 'ExportEnvelope' });
export type ExportEnvelope = z.infer<typeof ExportEnvelope>;
export const ExportNode = AddNodeRequest.omit({ spendRune: true, viewRune: true }).extend({
  id: z.uuid(),
  pubkey: PubkeySchema,
  createdAt: timestamp,
  viewRune: z.string().min(1).max(4096).optional(),
});
export const ExportIntent = z
  .strictObject({
    id: z.uuid(),
    node_id: z.uuid(),
    chain: Chain,
    pubkey: PubkeySchema,
    type: z.enum(['bolt11', 'onchain', 'channel-open', 'channel-close']),
    payment_hash: hash.nullable(),
    amount_msat: MsatString,
    max_fee_msat: MsatString,
    fee_msat: MsatString.nullable(),
    cost_msat: MsatString.nullable(),
    destination: z.string().max(4096).nullable(),
    state: z.enum(['reserved', 'sent', 'succeeded', 'failed', 'unknown']),
    idempotency_key: z.string().min(1).max(128),
    digest: hash,
    session_handle: z.uuid().nullable(),
    confirmation_hash: hash.nullable(),
    txid: hash.nullable(),
    channel_id: hash.nullable(),
    peer: PubkeySchema.nullable(),
    close_force: z.union([z.literal(0), z.literal(1)]).nullable(),
    error_code: z.string().max(128).nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .refine((i) => (i.type === 'bolt11') === (i.payment_hash !== null), 'Invalid payment identity.');
export const ExportPayload = z
  .strictObject({
    version: z.literal(1),
    createdAt: timestamp,
    includesViewCredentials: z.boolean(),
    settings: z.strictObject({
      sessionPolicy: SessionPolicy.optional(),
      alerts: z.union([SetupAlerts.options[0], SetupAlerts.options[1]]).optional(),
    }),
    nodes: z.array(ExportNode).max(EXPORT_RECORD_LIMITS.nodes),
    policies: z
      .array(z.strictObject({ chain: Chain, pubkey: PubkeySchema, policy: SpendPolicy }))
      .max(EXPORT_RECORD_LIMITS.policies),
    intents: z.array(ExportIntent).max(EXPORT_RECORD_LIMITS.intents),
    restoreCounts: z
      .array(z.strictObject({ chain: Chain, pubkey: PubkeySchema, countedMsat: MsatString, until: timestamp }))
      .max(EXPORT_RECORD_LIMITS.restoreCounts),
  })
  .refine(
    (p) => p.includesViewCredentials || p.nodes.every((n) => n.viewRune === undefined),
    'Unexpected credentials.',
  );
export type ExportPayload = z.infer<typeof ExportPayload>;
export const ExportRequest = z
  .strictObject({
    passphrase: ExportPassphrase,
    passphraseConfirmation: ExportPassphrase,
    includeViewCredentials: z.boolean().default(false),
  })
  .refine((v) => v.passphrase === v.passphraseConfirmation, 'The passphrases must match.')
  .meta({ id: 'ExportRequest' });
export const ImportRequest = z
  .strictObject({ passphrase: ExportPassphrase, envelope: ExportEnvelope })
  .meta({ id: 'ImportRequest' });
export const ImportResponse = z
  .strictObject({
    nodes: z.int().min(0),
    policies: z.int().min(0),
    intents: z.int().min(0),
    warnings: z.array(z.string()),
  })
  .meta({ id: 'ImportResponse' });
