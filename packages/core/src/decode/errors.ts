import { AppError } from '../errors.ts';

// Why a payment request was refused. The reason is fixed text chosen here, never the input, so it is safe to log and
// to show; the API layer maps it to an error code and a translated message.
export const DECODE_REASONS = [
  // Not parsable at all: bad checksum, bad characters, truncated fields, wrong lengths.
  'malformed',
  // A currency prefix or address version we do not know.
  'unknown_prefix',
  'invalid_amount',
  // The signature does not verify, or no public key can be recovered from it.
  'invalid_signature',
  // A field the format requires is missing (BOLT11 `p`, `s`, `d`/`h`).
  'missing_field',
  // An unknown even feature bit, or a feature without the feature it depends on.
  'unknown_feature',
  // A number written with leading zero words (BOLT11 `x`, `c`, `9`).
  'not_minimal',
  // Valid, but for another network than the node's (e.g. testnet4 for a mainnet node).
  'wrong_network',
  // Valid, but for the other chain profile (BOLT11 feature bit 512).
  'wrong_chain',
  // Two parts of one request disagree (e.g. a BIP21 amount that is not the invoice amount).
  'inconsistent',
  // Recognised, but not something release 0.1 can pay (BOLT12, unusual witness versions).
  'unsupported',
] as const;
export type DecodeReason = (typeof DECODE_REASONS)[number];

export class DecodeError extends Error {
  readonly reason: DecodeReason;
  constructor(reason: DecodeReason, message: string) {
    super(message);
    this.name = 'DecodeError';
    this.reason = reason;
  }
}

// The API answer for a refused payment request (owner decision 2026-10-13): `validation_failed` with the reason in
// `details.reason`, so the code list stays the same and the web app translates `errors.decode.<reason>`.
export function decodeFailure(err: DecodeError): AppError {
  return new AppError('validation_failed', err.message, { reason: err.reason });
}
