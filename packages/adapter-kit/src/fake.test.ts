import { describe, expect, it } from 'vitest';
import { msat, readBolt11 } from '@lightning-pilot/core';
import { FakeAdapter, FakeNetwork } from './fake.ts';

describe('fake adapter invoices', () => {
  it('encodes the expiry our BOLT11 reader decodes, matching expiresAt', async () => {
    const adapter = new FakeAdapter({ chain: 'blake2b' });
    for (const expirySeconds of [60, 3600, 86_400, 31_536_000]) {
      const invoice = await adapter.receive.createInvoice({
        amount: msat(1_000n),
        description: '',
        label: `l${expirySeconds}`,
        expirySeconds,
      });
      const decoded = readBolt11(invoice.bolt11);
      expect(decoded.expirySeconds).toBe(expirySeconds);
      expect(Math.abs(decoded.expiresAt.getTime() - Date.parse(invoice.expiresAt))).toBeLessThan(2000);
    }
  });
});

describe('fake adapter payments', () => {
  // A payment the fake refuses changes neither side, as on a real node.
  it('refuses more than the payer has, and an expired invoice, without paying anything', async () => {
    const world = new FakeNetwork();
    const payer = new FakeAdapter({ chain: 'blake2b', world });
    const payee = new FakeAdapter({ chain: 'blake2b', world });
    const before = (await payer.balance.getBalances()).lightning.local;
    const tooMuch = await payee.receive.createInvoice({ amount: msat(before + 1n), description: '', label: 'big' });
    await expect(
      payer.pay.pay({ bolt11: tooMuch.bolt11, label: 'p1', maxFee: msat(0n), retryForSeconds: 60 }),
    ).rejects.toMatchObject({
      code: 'payment_failed',
      definitive: true,
    });
    const expired = await payee.receive.createInvoice({
      amount: msat(1_000n),
      description: '',
      label: 'old',
      expirySeconds: 0,
    });
    await expect(
      payer.pay.pay({ bolt11: expired.bolt11, label: 'p2', maxFee: msat(0n), retryForSeconds: 60 }),
    ).rejects.toMatchObject({
      code: 'payment_failed',
      definitive: true,
    });
    for (const invoice of [tooMuch, expired]) {
      expect((await payee.receive.getInvoice(invoice.paymentHash))?.status).not.toBe('paid');
      expect(await payer.pay.getPayment(invoice.paymentHash)).toBeUndefined();
    }
    expect((await payer.balance.getBalances()).lightning.local).toBe(before);
  });
});
