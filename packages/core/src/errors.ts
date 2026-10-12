// Error codes shared by the server, the adapters and the web app. The server returns the code; the browser shows
// translated text for it. `message` never carries secrets or raw node text.
import { z } from 'zod';

export const ERROR_STATUS = {
  validation_failed: 400,
  body_too_large: 400,
  unknown_host: 421,
  bad_origin: 403,
  csrf_failed: 403,
  not_found: 404,
  too_early: 429,
  busy: 503,
  unauthenticated: 401,
  login_failed: 401,
  step_up_failed: 401,
  setup_token_invalid: 401,
  client_auth_failed: 401,
  step_up_required: 403,
  setup_required: 403,
  permission_denied: 403,
  client_scope_denied: 403,
  node_unreachable: 502,
  node_bad_response: 502,
  node_error: 502,
  node_credential_revoked: 409,
  node_unsupported_version: 409,
  capability_missing: 409,
  chain_waiting: 409,
  chain_refused: 409,
  limit_exceeded: 422,
  fee_cap_exceeded: 422,
  client_limit_exceeded: 422,
  confirmation_invalid: 409,
  idempotency_conflict: 409,
  spend_unknown: 409,
  payment_failed: 422,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];

export const ErrorBody = z
  .strictObject({
    error: z.strictObject({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string(),
    }),
  })
  .meta({ id: 'Error' });
export type ErrorBody = z.infer<typeof ErrorBody>;

// An error meant for the API caller. `details` must be safe to show (no secrets, no raw node text).
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

// Thrown by adapters. The spend module turns it into `failed` or `unknown`:
// - sent: false — the request never reached the node;
// - sent: true, definitive: true — the node said clearly that nothing was done;
// - sent: true, definitive: false — anything else (timeout, reset, unparsable or unknown reply).
export class AdapterError extends Error {
  readonly code: ErrorCode;
  readonly sent: boolean;
  readonly definitive: boolean;
  readonly nodeCode: number | undefined;
  // Raw node text, for the (redacted) log only; never sent to the browser.
  readonly detail: string | undefined;
  constructor(args: { code: ErrorCode; sent: boolean; definitive: boolean; nodeCode?: number; detail?: string }) {
    super(args.code);
    this.name = 'AdapterError';
    this.code = args.code;
    this.sent = args.sent;
    this.definitive = args.definitive;
    this.nodeCode = args.nodeCode;
    this.detail = args.detail;
  }
}
