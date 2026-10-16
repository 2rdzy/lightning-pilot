// Wallet reads and receiving: payment and invoice history and new on-chain receive addresses, through the
// view-only adapter. Preimages are never returned here: the owner sees a payment's preimage once, when it is made,
// and an invoice's preimage is our own secret.
import {
  AppError,
  toMsatString,
  untrustedText,
  type Invoice,
  type NewAddressType,
  type Page,
  type PageRequest,
  type PaymentHash,
  type Payment,
} from '@lightning-pilot/core';
import type { NodesService } from '../nodes/index.ts';

const LABEL_MAX = 200;

export const paymentJson = (p: Payment) => ({
  paymentHash: p.paymentHash,
  status: p.status,
  ...(p.destination === undefined ? {} : { destination: p.destination }),
  ...(p.amount === undefined ? {} : { amount: toMsatString(p.amount) }),
  ...(p.amountSent === undefined ? {} : { amountSent: toMsatString(p.amountSent) }),
  ...(p.fee === undefined ? {} : { fee: toMsatString(p.fee) }),
  ...(p.createdAt === undefined ? {} : { createdAt: p.createdAt }),
  ...(p.completedAt === undefined ? {} : { completedAt: p.completedAt }),
  ...(p.label === undefined ? {} : { label: untrustedText(p.label, LABEL_MAX) }),
  ...(p.parts === undefined ? {} : { parts: p.parts }),
});

export const invoiceJson = (i: Invoice) => ({
  paymentHash: i.paymentHash,
  bolt11: i.bolt11,
  ...(i.amount === undefined ? {} : { amount: toMsatString(i.amount) }),
  ...(i.amountReceived === undefined ? {} : { amountReceived: toMsatString(i.amountReceived) }),
  description: i.description,
  label: untrustedText(i.label, LABEL_MAX),
  status: i.status,
  ...(i.createdAt === undefined ? {} : { createdAt: i.createdAt }),
  expiresAt: i.expiresAt,
  ...(i.paidAt === undefined ? {} : { paidAt: i.paidAt }),
});

const pageOf = <T, U>(page: Page<T>, map: (item: T) => U) => ({
  items: page.items.map(map),
  ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
});

export class WalletService {
  readonly #nodes: NodesService;
  constructor(nodes: NodesService) {
    this.#nodes = nodes;
  }

  async payments(nodeId: string, page: PageRequest) {
    const { adapter } = await this.#nodes.readAdapter(nodeId, 'pay', 'listPayments');
    return pageOf(await adapter.pay.listPayments(page), paymentJson);
  }

  async payment(nodeId: string, hash: PaymentHash) {
    const { adapter } = await this.#nodes.readAdapter(nodeId, 'pay', 'getPayment');
    const payment = await adapter.pay.getPayment(hash);
    if (!payment) throw new AppError('not_found', 'The node has no payment with this hash.');
    return paymentJson(payment);
  }

  async invoices(nodeId: string, page: PageRequest) {
    const { adapter } = await this.#nodes.readAdapter(nodeId, 'receive', 'listInvoices');
    return pageOf(await adapter.receive.listInvoices(page), invoiceJson);
  }

  async invoice(nodeId: string, hash: PaymentHash) {
    const { adapter } = await this.#nodes.readAdapter(nodeId, 'receive', 'getInvoice');
    const invoice = await adapter.receive.getInvoice(hash);
    if (!invoice) throw new AppError('not_found', 'The node has no invoice with this hash.');
    return invoiceJson(invoice);
  }

  // Addresses look the same on both chains, so the chain identity check is the only thing that says which chain
  // an address receives on: refuse until it is confirmed, and name the profile in the reply.
  async newAddress(nodeId: string, type: NewAddressType) {
    const { row, adapter } = await this.#nodes.readAdapter(nodeId, 'receive', 'newAddress');
    const identity = this.#nodes.identity(row);
    if (identity.state === 'waiting') throw new AppError('chain_waiting', 'The node is not ready on its chain yet.');
    if (identity.state !== 'confirmed')
      throw new AppError('chain_refused', 'The node failed the chain identity check.');
    const address = await adapter.receive.newAddress(type);
    return {
      address: address.address,
      type: address.type,
      chain: row.chain,
      network: row.network,
      createdAt: address.createdAt,
    };
  }
}
