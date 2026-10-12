// The adapter contract suite (skeleton): the behaviour every adapter must show, run against the fake adapter here
// and against real nodes on both regtest chains (tools/regtest). A new backend is done when the suite passes.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  msat,
  parsePaymentHash,
  readBolt11,
  type Chain,
  type Network,
  type NodeAdapter,
} from '@lightning-pilot/core';

export interface ContractEnv {
  chain: Chain;
  network: Network;
  // The adapter under test, with view and spend credentials.
  adapter: NodeAdapter;
  // The same node with the view credential only.
  viewOnly: NodeAdapter;
  // An invoice from another node that the adapter's node can route to.
  invoiceElsewhere(amountMsat: bigint): Promise<string>;
  // Whether that invoice has been paid, as the other node sees it.
  isPaidElsewhere(paymentHash: string): Promise<boolean>;
}

const isHex = (s: string) => /^([0-9a-f]{2})*$/.test(s);
const versionTopBit = (rawHex: string) => (parseInt(rawHex.slice(6, 8), 16) & 0x80) !== 0;

export function adapterContract(name: string, setup: () => Promise<ContractEnv>): void {
  describe(`adapter contract: ${name}`, () => {
    let env: ContractEnv;
    const ready = async () => (env ??= await setup());

    it('node.getInfo reports a node of the expected network', async () => {
      const { adapter, network } = await ready();
      const info = await adapter.node.getInfo();
      expect(info.pubkey).toMatch(/^0[23][0-9a-f]{64}$/);
      expect(info.network).toBe(network);
      expect(info.blockHeight).toBeGreaterThan(0);
      expect(isHex(info.features)).toBe(true);
    });

    it("chain.getTipHeader returns the tip block in the chain's header format", async () => {
      const { adapter, chain } = await ready();
      const info = await adapter.node.getInfo();
      const tip = await adapter.chain.getTipHeader();
      expect(tip.height).toBeGreaterThanOrEqual(info.blockHeight);
      expect(isHex(tip.raw)).toBe(true);
      expect(versionTopBit(tip.raw)).toBe(chain === 'blake2b');
      expect(tip.raw.length / 2).toBeGreaterThan(chain === 'blake2b' ? 164 : 80);
    });

    it('balance.getBalances returns non-negative msat amounts', async () => {
      const { adapter } = await ready();
      const b = await adapter.balance.getBalances();
      const amounts = [...Object.values(b.onchain), ...Object.values(b.lightning), b.pendingClose];
      for (const a of amounts) {
        expect(typeof a).toBe('bigint');
        expect(a >= 0n).toBe(true);
      }
      expect(b.lightning.local > 0n).toBe(true);
    });

    it('receive.createInvoice returns an invoice our decoder reads back', async () => {
      const { adapter, network } = await ready();
      const label = `contract-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const invoice = await adapter.receive.createInvoice({ amount: msat(12_345n), description: 'contract', label });
      const decoded = readBolt11(invoice.bolt11);
      expect(decoded.network).toBe(network);
      expect(decoded.amount).toBe(12_345n);
      expect(decoded.paymentHash).toBe(invoice.paymentHash);
      expect(invoice.status).toBe('unpaid');
    });

    it('pay.pay pays an invoice on another node and returns its preimage', async () => {
      const { adapter, invoiceElsewhere, isPaidElsewhere } = await ready();
      const bolt11 = await invoiceElsewhere(21_000n);
      const label = `contract-pay-${Date.now()}`;
      const result = await adapter.pay.pay({ bolt11, maxFee: msat(10_000n), label, retryForSeconds: 30 });
      const hash = createHash('sha256').update(Buffer.from(result.preimage, 'hex')).digest('hex');
      expect(result.paymentHash).toBe(hash);
      expect(result.paymentHash).toBe(readBolt11(bolt11).paymentHash);
      expect(result.amount).toBe(21_000n);
      expect(result.amountSent >= result.amount).toBe(true);
      expect(await isPaidElsewhere(result.paymentHash)).toBe(true);
      const record = await adapter.pay.getPayment(result.paymentHash);
      expect(record?.status).toBe('succeeded');
      expect(record?.label).toBe(label);
    });

    it('pay.getPayment knows nothing of a payment hash never paid', async () => {
      const { adapter } = await ready();
      expect(await adapter.pay.getPayment(parsePaymentHash('ab'.repeat(32)))).toBeUndefined();
    });

    it('refuses to pay without a spend credential, before anything is sent', async () => {
      const { viewOnly, invoiceElsewhere } = await ready();
      const bolt11 = await invoiceElsewhere(1_000n);
      const attempt = viewOnly.pay.pay({
        bolt11,
        maxFee: msat(1_000n),
        label: `contract-ro-${Date.now()}`,
        retryForSeconds: 5,
      });
      await expect(attempt).rejects.toBeInstanceOf(AdapterError);
      await expect(attempt).rejects.toMatchObject({ sent: false, definitive: true });
    });
  });
}
