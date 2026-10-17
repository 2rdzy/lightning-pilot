// The universal pay input (catalogue D2, MVP scope): decide in the browser what was pasted or scanned, so the screen
// can send a Lightning invoice to the preview and point everything else to where it belongs. The browser only
// classifies: the server decodes the invoice again and is the authority on chain, network, expiry and limits.
import { DecodeError, decodeRequest, type Chain, type DecodeReason, type Network } from '@lightning-pilot/core';

export type Classified =
  // A BOLT11 invoice, pasted or carried by a bitcoin: URI (BIP321 `lightning=`), with the URI's own texts.
  | { kind: 'invoice'; bolt11: string; label?: string; message?: string }
  // An on-chain address, or a bitcoin: URI without an invoice: sent from the on-chain screen, which the hand-off
  // prefills with the address and the URI's amount in sats (msat in the URI, whole sats only).
  | { kind: 'onchain'; address: string; amountSats?: string }
  // A node URI: a peer to connect to, not something to pay.
  | { kind: 'node'; uri: string }
  // Recognised, but not payable in this release (BOLT12 with D7, Lightning address and LNURL with D8 and D10).
  | { kind: 'unsupported' }
  | { kind: 'invalid'; reason: DecodeReason }
  | { kind: 'unknown' };

// apps/web may not import the chain profiles (lint), so the bit-512 rule is restated from the node's chain here;
// a mistake would only change which message is shown first, as the server applies @lightning-pilot/chain's rule.
const INVOICE_BIT_512: Record<Chain, 'required' | 'refused'> = { blake2b: 'required', bitcoin: 'refused' };

const LIGHTNING_INVOICE = /^(lightning:)?ln[a-z]*1/i;

function onchain(address: string, amount?: bigint): Classified {
  return {
    kind: 'onchain',
    address,
    ...(amount !== undefined && amount > 0n && amount % 1000n === 0n
      ? { amountSats: (amount / 1000n).toString() }
      : {}),
  };
}

export function classifyRequest(text: string, chain: Chain, network: Network): Classified {
  const raw = text.trim();
  let decoded;
  try {
    decoded = decodeRequest(raw, { network, invoiceBit512: INVOICE_BIT_512[chain] });
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    // An invoice the browser refuses still goes to the server, whose answer (and reason) is the one shown.
    if (LIGHTNING_INVOICE.test(raw) && !/^ln(o|i|r|url)1/i.test(raw.replace(/^lightning:/i, '')))
      return { kind: 'invoice', bolt11: raw };
    return { kind: 'invalid', reason: error.reason };
  }
  switch (decoded.kind) {
    case 'bolt11':
      return { kind: 'invoice', bolt11: raw };
    case 'bip21': {
      const { lightning, label, message } = decoded.uri;
      if (!lightning)
        return decoded.uri.address ? onchain(decoded.uri.address.address, decoded.uri.amount) : { kind: 'unsupported' };
      return {
        kind: 'invoice',
        bolt11: lightning.bolt11,
        ...(label ? { label } : {}),
        ...(message ? { message } : {}),
      };
    }
    case 'onchain-address':
      return onchain(decoded.address.address);
    case 'node-uri':
      return { kind: 'node', uri: raw };
    case 'unknown':
      return { kind: 'unknown' };
    default:
      return { kind: 'unsupported' };
  }
}
