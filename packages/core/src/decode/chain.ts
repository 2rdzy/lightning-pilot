// The chain rule for invoices: the BLAKE2b chain's nodes (CLN fork, Lightning Fork) set feature bit 512
// (`option_blake2b`) in every invoice; stock nodes do not. Stock LND tries to pay a bit-512 invoice and fails later
// with NO_ROUTE, so the rule is ours, applied before any spend. The odd bit 513 counts as set too, as in the CLN
// fork's own check (common/bolt11.c `bolt11_check_blake2b`, `feature_offered`).
import type { Network } from '../domain.ts';
import { DecodeError } from './errors.ts';

// What the decoder needs from the node's chain profile (`@lightning-pilot/chain` PROFILES[chain]) and node record.
export interface ChainContext {
  network: Network;
  invoiceBit512: 'required' | 'refused';
}

const BLAKE2B_BITS = [512, 513];

export function checkInvoiceChain(
  invoice: { network: Network; featureBits: readonly number[] },
  context: ChainContext,
): void {
  if (invoice.network !== context.network) {
    throw new DecodeError(
      'wrong_network',
      `This invoice is for ${invoice.network}, the node is on ${context.network}.`,
    );
  }
  const blake2b = invoice.featureBits.some((bit) => BLAKE2B_BITS.includes(bit));
  if (context.invoiceBit512 === 'required' && !blake2b) {
    throw new DecodeError('wrong_chain', 'This invoice is for Bitcoin (SHA256d); the node is on Bitcoin BLAKE2b.');
  }
  if (context.invoiceBit512 === 'refused' && blake2b) {
    throw new DecodeError('wrong_chain', 'This invoice is for Bitcoin BLAKE2b; the node is on Bitcoin (SHA256d).');
  }
}
