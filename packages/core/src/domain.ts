// Domain types used between the adapters and the server. Amounts are Msat (bigint); the API layer turns them into
// decimal strings (api.ts).
import { z } from 'zod';
import type { PaymentHash, Pubkey } from './ids.ts';
import type { Msat } from './money.ts';
import type { UntrustedText } from './text.ts';

// The two chain profiles: Bitcoin BLAKE2b and Bitcoin (SHA256d). Genesis and network names are the same on both, so
// the profile is chosen per node and enforced by the chain identity check.
export const CHAINS = ['blake2b', 'bitcoin'] as const;
export const Chain = z.enum(CHAINS);
export type Chain = z.infer<typeof Chain>;

export const NETWORKS = ['mainnet', 'testnet4', 'signet', 'regtest'] as const;
export const Network = z.enum(NETWORKS);
export type Network = z.infer<typeof Network>;

export const IMPLEMENTATIONS = ['cln', 'lnd'] as const;
export const Implementation = z.enum(IMPLEMENTATIONS);
export type Implementation = z.infer<typeof Implementation>;

export interface NodeRef {
  chain: Chain;
  network: Network;
  pubkey: Pubkey;
}

export const IDENTITY_STATES = ['confirmed', 'waiting', 'refused'] as const;
export type IdentityState = (typeof IDENTITY_STATES)[number];
// Which part of the chain identity check failed. `node`: the node at the stored address answers with another public
// key than the node that was added (rebuilt with a new key, or another machine answering for it); the chain checks
// alone would not notice, since they look at the chain, not at who answers.
export const FAILED_CHECKS = ['network', 'software', 'header', 'fork_height', 'sync', 'unreachable', 'node'] as const;
export type FailedCheck = (typeof FAILED_CHECKS)[number];

export interface ChainIdentityState {
  state: IdentityState;
  profile: Chain;
  checkedAt: string;
  failedCheck?: FailedCheck;
  detail?: string;
}

// What the node says about itself (NodeInfo without the chain identity, which the server adds).
export interface NodeFacts {
  pubkey: Pubkey;
  alias: UntrustedText;
  color: string;
  implementation: Implementation;
  version: string;
  // `unknown` when the node reports a network we do not know; the raw name is kept.
  network: Network | 'unknown';
  networkRaw: string;
  blockHeight: number;
  synced: boolean;
  numPeers: number;
  numActiveChannels: number;
  numPendingChannels: number;
  numInactiveChannels: number;
  // Node feature bits from the init message, hex, most significant byte first.
  features: string;
}

export interface Balances {
  onchain: { confirmed: Msat; unconfirmed: Msat; reserved: Msat };
  lightning: { local: Msat; spendable: Msat; remote: Msat; receivable: Msat };
  pendingClose: Msat;
}

export interface Invoice {
  paymentHash: PaymentHash;
  bolt11: string;
  amount?: Msat;
  description: UntrustedText;
  label: string;
  status: 'unpaid' | 'paid' | 'expired';
  expiresAt: string;
}

export type PaymentStatus = 'pending' | 'succeeded' | 'failed';

export interface Payment {
  paymentHash: PaymentHash;
  status: PaymentStatus;
  amount?: Msat;
  amountSent?: Msat;
  preimage?: string;
  label?: string;
}

export interface PayResult {
  paymentHash: PaymentHash;
  preimage: string;
  amount: Msat;
  amountSent: Msat;
  fee: Msat;
}

export const SPEND_STATES = ['reserved', 'sent', 'succeeded', 'failed', 'unknown'] as const;
export type SpendState = (typeof SPEND_STATES)[number];
