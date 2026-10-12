// Redaction for the service log. Two layers, both always on, at every level:
// 1. field names on a deny list are replaced by "[redacted]" at any depth;
// 2. every string value is scanned and secret-shaped substrings are replaced.
// A few fields (paymentHash, txid, channelId, fundingOutpoint, pubkey) are kept as they are, but only when the value
// has that field's exact shape; the logger's types also accept them only as values made by the parsers in core.
import { ID_PATTERNS } from '@lightning-pilot/core';

export const REDACTED = '[redacted]';

const DENY = [
  'password',
  'secret',
  'token',
  'rune',
  'macaroon',
  'cookie',
  'authorization',
  'preimage',
  'seed',
  'mnemonic',
  'psbt',
  'key',
  'nostr',
];
const ALLOWED_NAMES = new Set(['keyId']);
const TYPED: Record<string, RegExp> = ID_PATTERNS;

const VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+\S+/gi,
  // Invoices and offers (logged by payment hash instead).
  /\bln(bcrt|tbs|bc|tb|o|i)[0-9a-z]{20,}/gi,
  /\b[xt]prv[1-9A-HJ-NP-Za-km-z]{20,}/g,
  /cHNidP[A-Za-z0-9+/=]*/g,
  /\bnsec1[0-9a-z]{20,}/gi,
  // Telegram bot token: digits, colon, 35 characters.
  /\b[0-9]{6,12}:[A-Za-z0-9_-]{35}\b/g,
  // Long hex (macaroons, preimages, keys).
  /\b[0-9a-fA-F]{64,}\b/g,
  // Rune-shaped base64url (and other long base64 blobs).
  /[A-Za-z0-9_-]{40,}={0,2}/g,
];

export function redactString(value: string): string {
  return VALUE_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
}

const denied = (name: string) => !ALLOWED_NAMES.has(name) && DENY.some((d) => name.toLowerCase().includes(d));

export function redact(value: unknown, name = '', depth = 0): unknown {
  if (depth > 8) return REDACTED;
  const typed = TYPED[name];
  if (typed !== undefined) return typeof value === 'string' && typed.test(value) ? value : REDACTED;
  if (name !== '' && denied(name)) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: redactString(value.stack ?? '') };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, '', depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, depth + 1)]));
  }
  return value;
}

// Node error text is logged only after redaction and cut to 500 characters; it is never sent to the browser.
export const nodeDetail = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : redactString(text).slice(0, 500);
