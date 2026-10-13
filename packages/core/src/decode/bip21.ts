// `bitcoin:` payment URIs: BIP21 as updated by BIP321 (address may be empty when a query key carries a payment
// instruction; `lightning` = BOLT11 invoice, `lno` = BOLT12 offer; keys are case-insensitive; unknown `req-` keys
// make the whole URI invalid). https://github.com/bitcoin/bips/blob/master/bip-0321.mediawiki
import type { Msat } from '../money.ts';
import { msat } from '../money.ts';
import { untrustedText, type UntrustedText } from '../text.ts';
import { decodeAddress, type OnchainAddress } from './address.ts';
import { MAX_AMOUNT } from './bolt11.ts';
import { checkInvoiceChain, type ChainContext } from './chain.ts';
import { DecodeError } from './errors.ts';
import { decodeBolt11, type Bolt11Invoice } from './invoice.ts';

export interface PaymentUri {
  address?: OnchainAddress;
  // From `amount` (decimal coins), or the invoice's amount when the URI has none.
  amount?: Msat;
  label?: UntrustedText;
  message?: UntrustedText;
  // Checked for the node's chain and network like a pasted invoice.
  lightning?: Bolt11Invoice;
  // BOLT12 offer: recognised only (not supported in release 0.1).
  offer?: string;
}

const SCHEME = /^bitcoin:/i;
const SINGLE_KEYS = new Set(['amount', 'label', 'message', 'pop']);
// Payment instructions we know of but cannot pay (BIP321: BIP351 private payments, BIP352 silent payments).
const OTHER_INSTRUCTIONS = new Set(['lno', 'pay', 'sp']);
const MSAT_PER_COIN = 100_000_000_000n;

export function isPaymentUri(input: string): boolean {
  return SCHEME.test(input.trim());
}

// BIP321: decimal coins with a period, no commas. At most 8 decimals: an on-chain amount is whole satoshis.
function readCoins(value: string): Msat {
  const match = /^([0-9]*)(?:\.([0-9]*))?$/.exec(value);
  const whole = match?.[1] ?? '';
  const fraction = match?.[2] ?? '';
  if (!match || (whole === '' && fraction === '') || fraction.length > 8) {
    throw new DecodeError('invalid_amount', 'The amount in the payment link is not valid.');
  }
  const amount = BigInt(whole || '0') * MSAT_PER_COIN + BigInt(fraction.padEnd(8, '0')) * 1000n;
  if (amount === 0n || amount > MAX_AMOUNT) {
    throw new DecodeError('invalid_amount', 'The amount in the payment link is not valid.');
  }
  return msat(amount);
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DecodeError('malformed', 'The payment link is not correctly encoded.');
  }
}

export function decodePaymentUri(input: string, context: ChainContext): PaymentUri {
  const text = input.trim();
  if (!SCHEME.test(text)) throw new DecodeError('malformed', 'Not a bitcoin: payment link.');
  const rest = text.slice('bitcoin:'.length);
  const query = rest.indexOf('?');
  const path = query === -1 ? rest : rest.slice(0, query);
  const params = new Map<string, string[]>();
  for (const pair of query === -1 ? [] : rest.slice(query + 1).split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = percentDecode(eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? '' : percentDecode(pair.slice(eq + 1));
    const values = params.get(key) ?? [];
    if (values.length > 0 && SINGLE_KEYS.has(key)) {
      throw new DecodeError('malformed', `The payment link has more than one "${key}".`);
    }
    params.set(key, [...values, value]);
  }

  const known = new Set([...SINGLE_KEYS, 'lightning', ...OTHER_INSTRUCTIONS]);
  for (const key of params.keys()) {
    // A required key we do not implement makes the whole URI invalid. `req-pop` too: we never open a pop URI.
    if (key.startsWith('req-')) {
      throw new DecodeError('unsupported', 'The payment link requires a feature that is not supported.');
    }
    if (!known.has(key)) params.delete(key);
  }

  const result: PaymentUri = {};
  const address = percentDecode(path);
  if (address !== '') result.address = decodeAddress(address, context.network);
  const [lightning] = params.get('lightning') ?? [];
  if (lightning !== undefined) {
    const invoice = decodeBolt11(lightning);
    checkInvoiceChain(invoice, context);
    result.lightning = invoice;
  }
  const [offer] = params.get('lno') ?? [];
  if (offer !== undefined) result.offer = offer;
  const [amount] = params.get('amount') ?? [];
  if (amount !== undefined) result.amount = readCoins(amount);
  if (result.lightning?.amount !== undefined) {
    // The URI amount is whole satoshis, the invoice's is millisatoshis: they agree when they differ by less than a
    // satoshi (wallets round the invoice amount either way). The invoice amount is the one paid.
    const difference = result.amount === undefined ? 0n : result.amount - result.lightning.amount;
    if (difference <= -1000n || difference >= 1000n) {
      throw new DecodeError('inconsistent', 'The amount in the payment link differs from the invoice amount.');
    }
    result.amount = result.lightning.amount;
  }
  const [label] = params.get('label') ?? [];
  if (label !== undefined) result.label = untrustedText(label);
  const [message] = params.get('message') ?? [];
  if (message !== undefined) result.message = untrustedText(message);

  if (!result.address && !result.lightning) {
    const other = [...OTHER_INSTRUCTIONS].some((key) => params.has(key));
    throw other
      ? new DecodeError('unsupported', 'This payment link has no payment method that is supported.')
      : new DecodeError('malformed', 'The payment link has no address and no invoice.');
  }
  return result;
}
