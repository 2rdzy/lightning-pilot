// The universal input: one text field on the pay screen accepts anything a payer may paste or scan. This decides
// what it is and decodes it fully, checked against the node's chain and network. Nothing here contacts the network:
// Lightning addresses and LNURLs are only recognised (the guarded fetcher resolves them).
import { bech32 } from '@scure/base';
import type { Network } from '../domain.ts';
import type { PaymentHash, Pubkey } from '../ids.ts';
import type { Msat } from '../money.ts';
import { untrustedText, type UntrustedText } from '../text.ts';
import { decodeAddress, type OnchainAddress } from './address.ts';
import { decodePaymentUri, isPaymentUri, type PaymentUri } from './bip21.ts';
import { checkInvoiceChain, type ChainContext } from './chain.ts';
import { DecodeError } from './errors.ts';
import { decodeBolt11, type Bolt11Invoice } from './invoice.ts';
import { decodeNodeUri, isNodePubkey, type NodeUri } from './node-uri.ts';
import { wordsToBytes } from './words.ts';

export const REQUEST_KINDS = [
  'bolt11',
  'bolt12-offer',
  'bolt12-invoice',
  'onchain-address',
  'bip21',
  'lightning-address',
  'lnurl',
  'node-uri',
  'unknown',
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

interface Common {
  // The input, trimmed.
  raw: string;
  // False for what release 0.1 recognises but cannot pay (BOLT12) and for input it does not recognise.
  supported: boolean;
  network?: Network;
  payee?: Pubkey;
  amount?: Msat;
  description: UntrustedText;
  expiresAt?: Date;
  paymentHash?: PaymentHash;
}

export type DecodedRequest = Common &
  (
    | { kind: 'bolt11'; invoice: Bolt11Invoice }
    | { kind: 'bip21'; uri: PaymentUri }
    | { kind: 'onchain-address'; address: OnchainAddress }
    | { kind: 'node-uri'; node: NodeUri }
    | { kind: 'lightning-address'; user: string; domain: string }
    | { kind: 'lnurl'; url: string }
    | { kind: 'bolt12-offer' | 'bolt12-invoice' | 'unknown' }
  );

const NO_TEXT = untrustedText('');
// LUD-16: the user name is lower-case letters, digits and -_.+
const LIGHTNING_ADDRESS = /^([a-z0-9\-_.+]+)@([a-z0-9-]+(\.[a-z0-9-]+)+)$/;
// LUD-17 schemes, which stand for https (http for .onion).
const LUD17 = /^(lnurlc|lnurlw|lnurlp|keyauth):\/\//;
// BOLT12 strings: bech32 characters without a checksum, which may be split with `+` and whitespace.
const BOLT12 = /^(lno|lni|lnr)1[02-9ac-hj-np-z+\s]+$/;
// Shapes that can only be meant as an address, so their errors are reported rather than "not recognised".
const ADDRESS_SHAPE = /^((bc|tb|bcrt)1[a-z0-9]{6,}|[123mn][1-9A-HJ-NP-Za-km-z]{25,34})$/i;

function invoiceFields(invoice: Bolt11Invoice): Omit<Common, 'raw' | 'supported'> {
  return {
    network: invoice.network,
    payee: invoice.payee,
    ...(invoice.amount === undefined ? {} : { amount: invoice.amount }),
    description: invoice.description ?? NO_TEXT,
    expiresAt: invoice.expiresAt,
    paymentHash: invoice.paymentHash,
  };
}

function decodeLnurl(text: string): string {
  let url: string;
  if (LUD17.test(text)) {
    const rest = text.replace(LUD17, '');
    url = `${/^[^/?#]+\.onion([/?#:]|$)/.test(rest) ? 'http' : 'https'}://${rest}`;
  } else {
    try {
      const { words } = bech32.decode(text as `${string}1${string}`, false);
      const bytes = wordsToBytes(words);
      if (!bytes) throw new Error('padding');
      url = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new DecodeError('malformed', 'Not a valid LNURL.');
    }
  }
  try {
    return new URL(url).href;
  } catch {
    throw new DecodeError('malformed', 'Not a valid LNURL.');
  }
}

// Decodes any payment request for a node on the given network and chain profile. Throws DecodeError when the input
// is recognised but not valid (bad checksum, wrong chain, wrong network...); returns kind `unknown` when it is not
// recognised at all.
export function decodeRequest(input: string, context: ChainContext): DecodedRequest {
  const raw = input.trim();
  if (isPaymentUri(raw)) {
    const uri = decodePaymentUri(raw, context);
    const fields = uri.lightning ? invoiceFields(uri.lightning) : { network: context.network, description: NO_TEXT };
    return {
      ...fields,
      kind: 'bip21',
      raw,
      supported: true,
      uri,
      ...(uri.amount === undefined ? {} : { amount: uri.amount }),
      description: uri.lightning?.description ?? uri.message ?? NO_TEXT,
    };
  }
  const text = raw.replace(/^lightning:/i, '');
  const lower = text.toLowerCase();

  if (LUD17.test(lower) || lower.startsWith('lnurl1')) {
    return {
      kind: 'lnurl',
      raw,
      supported: true,
      description: NO_TEXT,
      url: decodeLnurl(LUD17.test(lower) ? text : lower),
    };
  }
  const bolt12 = BOLT12.exec(lower);
  if (bolt12) {
    const kind = bolt12[1] === 'lno' ? 'bolt12-offer' : bolt12[1] === 'lni' ? 'bolt12-invoice' : 'unknown';
    return { kind, raw, supported: false, description: NO_TEXT };
  }
  if (lower.startsWith('ln') && !lower.includes('@')) {
    const invoice = decodeBolt11(text);
    checkInvoiceChain(invoice, context);
    return { kind: 'bolt11', raw, supported: true, invoice, ...invoiceFields(invoice) };
  }
  const at = lower.indexOf('@');
  if (isNodePubkey(at === -1 ? lower : lower.slice(0, at))) {
    const node = decodeNodeUri(text);
    return { kind: 'node-uri', raw, supported: true, description: NO_TEXT, payee: node.pubkey, node };
  }
  const address = LIGHTNING_ADDRESS.exec(lower);
  if (address) {
    return {
      kind: 'lightning-address',
      raw,
      supported: true,
      description: NO_TEXT,
      user: address[1] ?? '',
      domain: address[2] ?? '',
    };
  }
  if (ADDRESS_SHAPE.test(text)) {
    const onchain = decodeAddress(text, context.network);
    return {
      kind: 'onchain-address',
      raw,
      supported: true,
      network: onchain.network,
      description: NO_TEXT,
      address: onchain,
    };
  }
  return { kind: 'unknown', raw, supported: false, description: NO_TEXT };
}
