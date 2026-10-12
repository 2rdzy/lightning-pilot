// The adapter contract: one interface per implementation, split into ports. This first version has the ports the
// walking skeleton needs; the others (channels, peers, on-chain, routing, events) come with the complete adapter.
// Methods marked "spend" need the spend credential and are called only by the server's spend module.
import type { Balances, Implementation, Invoice, NodeFacts, Payment, PayResult } from './domain.ts';
import type { PaymentHash } from './ids.ts';
import type { Msat } from './money.ts';

export interface NodePort {
  getInfo(): Promise<NodeFacts>;
}

export interface ChainPort {
  // The latest block: its height and its raw bytes as hex. The bytes start with the block header and include at
  // least the transaction count, so the header format can be checked (CLN returns the whole block).
  getTipHeader(): Promise<{ height: number; raw: string }>;
}

export interface BalancePort {
  getBalances(): Promise<Balances>;
}

export interface NewInvoice {
  amount: Msat;
  description: string;
  label: string;
  expirySeconds?: number;
}

export interface ReceivePort {
  createInvoice(request: NewInvoice): Promise<Invoice>;
}

export interface PayRequest {
  bolt11: string;
  maxFee: Msat;
  // Our spend intent id, stored by the node with the payment so its outcome can be found after a crash.
  label: string;
  retryForSeconds: number;
}

export interface PayPort {
  // read: the node's record of a payment, or undefined if it has none.
  getPayment(paymentHash: PaymentHash): Promise<Payment | undefined>;
  // spend: never retried by the adapter.
  pay(request: PayRequest): Promise<PayResult>;
}

export interface NodeAdapter {
  readonly implementation: Implementation;
  readonly node: NodePort;
  readonly chain: ChainPort;
  readonly balance: BalancePort;
  readonly receive: ReceivePort;
  readonly pay: PayPort;
}
