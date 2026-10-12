// The API contract: request and response schemas for /api/v1, shared by the server (validation, OpenAPI) and the
// web app (typed client, forms). Every object is strict: unknown fields are refused. Amounts are msat strings.
import { z } from 'zod';
import { Chain, FAILED_CHECKS, IDENTITY_STATES, Implementation, Network } from './domain.ts';
import { PaymentHashSchema, PubkeySchema } from './ids.ts';
import { MsatString } from './money.ts';

// Permissions a route can declare. `public` routes answer without a session (health, login); `setup` routes answer
// only while no owner exists. The owner's session holds every other permission.
export const PERMISSIONS = ['public', 'setup', 'read', 'receive', 'manage', 'spend'] as const;
export type Permission = (typeof PERMISSIONS)[number];

// Owner decision: at least 12 characters with lowercase, uppercase, a digit and a symbol.
export const Password = z
  .string()
  .min(12, 'at least 12 characters')
  .max(1024)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p), {
    message: 'needs lowercase, uppercase, a digit and a symbol',
  });

export const SetupStatusResponse = z.strictObject({ setupRequired: z.boolean() }).meta({ id: 'SetupStatus' });

export const SetupRequest = z
  .strictObject({
    // Groups of letters and digits as printed in the log; separators and case are ignored.
    token: z.string().min(1).max(200),
    password: Password,
  })
  .meta({ id: 'SetupRequest' });

export const LoginRequest = z.strictObject({ password: z.string().min(1).max(1024) }).meta({ id: 'LoginRequest' });

export const SessionResponse = z
  .strictObject({
    // Sent back in the X-CSRF-Token header on every state-changing request.
    csrfToken: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'Session' });

export const NodeIdParam = z.strictObject({ nodeId: z.uuid() });

const PEM = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/;

export const AddNodeRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(64),
    chain: Chain,
    network: Network,
    implementation: z.literal('cln'),
    // clnrest base URL. HTTPS only: the node's certificate authority is pinned.
    url: z.url({ protocol: /^https$/ }).max(200),
    caCertificate: z.string().max(16384).regex(PEM, 'a PEM certificate'),
    // The name the node's certificate was issued for; clnrest's own certificate uses "localhost".
    serverName: z.string().min(1).max(253).default('localhost'),
    viewRune: z.string().min(1).max(4096),
    spendRune: z.string().min(1).max(4096).optional(),
  })
  .meta({ id: 'AddNodeRequest' });
export type AddNodeRequest = z.input<typeof AddNodeRequest>;

export const ChainIdentityResponse = z
  .strictObject({
    state: z.enum(IDENTITY_STATES),
    profile: Chain,
    checkedAt: z.iso.datetime(),
    failedCheck: z.enum(FAILED_CHECKS).optional(),
    detail: z.string().optional(),
  })
  .meta({ id: 'ChainIdentity' });

export const NodeSummary = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    chain: Chain,
    network: Network,
    implementation: Implementation,
    pubkey: PubkeySchema,
    canSpend: z.boolean(),
    chainIdentity: ChainIdentityResponse,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'NodeSummary' });

export const NodeListResponse = z.strictObject({ items: z.array(NodeSummary) }).meta({ id: 'NodeList' });

export const NodeInfoResponse = z
  .strictObject({
    id: z.uuid(),
    pubkey: PubkeySchema,
    alias: z.string(),
    color: z.string(),
    implementation: Implementation,
    version: z.string(),
    chain: Chain,
    network: Network,
    blockHeight: z.int().nonnegative(),
    synced: z.boolean(),
    numPeers: z.int().nonnegative(),
    numActiveChannels: z.int().nonnegative(),
    numPendingChannels: z.int().nonnegative(),
    numInactiveChannels: z.int().nonnegative(),
    chainIdentity: ChainIdentityResponse,
  })
  .meta({ id: 'NodeInfo' });

export const BalancesResponse = z
  .strictObject({
    onchain: z.strictObject({ confirmed: MsatString, unconfirmed: MsatString, reserved: MsatString }),
    lightning: z.strictObject({
      local: MsatString,
      spendable: MsatString,
      remote: MsatString,
      receivable: MsatString,
    }),
    pendingClose: MsatString,
  })
  .meta({ id: 'Balances' });

export const CreateInvoiceRequest = z
  .strictObject({
    amount: MsatString.refine((a) => a !== '0', 'more than zero'),
    description: z.string().max(640).default(''),
    expirySeconds: z.int().min(60).max(31_536_000).optional(),
  })
  .meta({ id: 'CreateInvoiceRequest' });

export const InvoiceResponse = z
  .strictObject({
    paymentHash: PaymentHashSchema,
    bolt11: z.string(),
    amount: MsatString.optional(),
    description: z.string(),
    status: z.enum(['unpaid', 'paid', 'expired']),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'Invoice' });

export const PaymentPreviewRequest = z
  .strictObject({ request: z.string().trim().min(1).max(4096) })
  .meta({ id: 'PaymentPreviewRequest' });

export const PaymentPreviewResponse = z
  .strictObject({
    // Single-use, valid for two minutes, only for this session; the only way to execute this payment.
    confirmationToken: z.string(),
    decoded: z.strictObject({
      kind: z.literal('bolt11'),
      network: Network,
      paymentHash: PaymentHashSchema,
      amount: MsatString,
      expiresAt: z.iso.datetime(),
    }),
    cost: z.strictObject({ amount: MsatString, maxFee: MsatString, total: MsatString }),
    chainIdentity: ChainIdentityResponse,
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'PaymentPreview' });

export const PaymentExecuteRequest = z
  .strictObject({ confirmationToken: z.string().min(1).max(200) })
  .meta({ id: 'PaymentExecuteRequest' });

// Sent by the client with every spending request; a retry with the same key returns the first result. Not strict:
// the other request headers are part of the validated object.
export const IdempotencyHeader = z.object({
  'idempotency-key': z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .meta({ description: '16 to 128 characters of [A-Za-z0-9_-], new for each payment' }),
});

export const PaymentResultResponse = z
  .strictObject({
    intentId: z.uuid(),
    state: z.enum(['succeeded', 'failed', 'unknown']),
    paymentHash: PaymentHashSchema,
    amount: MsatString,
    fee: MsatString.optional(),
    // Present only once the payment succeeded: proof of payment.
    preimage: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .meta({ id: 'PaymentResult' });

export const HealthResponse = z.strictObject({ status: z.literal('ok') }).meta({ id: 'Health' });
