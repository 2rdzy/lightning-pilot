import { describe, expect, it } from 'vitest';
import { msat, parsePaymentHash, parsePubkey, untrustedText, type Invoice, type Payment } from '@lightning-pilot/core';
import { invoiceJson, paymentJson } from './service.ts';

const hash = parsePaymentHash('ab'.repeat(32));

describe('wallet records', () => {
  it('maps every payment field the node reports, and never a preimage', () => {
    const full: Payment = {
      paymentHash: hash,
      status: 'succeeded',
      destination: parsePubkey('02' + 'cd'.repeat(32)),
      amount: msat(1000n),
      amountSent: msat(1010n),
      fee: msat(10n),
      createdAt: '2026-10-16T10:00:00.000Z',
      completedAt: '2026-10-16T10:00:01.000Z',
      preimage: 'ef'.repeat(32),
      label: 'x'.repeat(300),
      parts: 2,
    };
    const json = paymentJson(full);
    expect(json).toEqual({
      paymentHash: hash,
      status: 'succeeded',
      destination: full.destination,
      amount: '1000',
      amountSent: '1010',
      fee: '10',
      createdAt: full.createdAt,
      completedAt: full.completedAt,
      label: 'x'.repeat(200),
      parts: 2,
    });
    expect(paymentJson({ paymentHash: hash, status: 'pending' })).toEqual({ paymentHash: hash, status: 'pending' });
  });

  it('maps every invoice field the node reports, and never a preimage', () => {
    const full: Invoice = {
      paymentHash: hash,
      bolt11: 'lnbcrt1',
      amount: msat(5000n),
      amountReceived: msat(5000n),
      description: untrustedText('coffee'),
      label: 'lp-1',
      status: 'paid',
      createdAt: '2026-10-16T10:00:00.000Z',
      expiresAt: '2026-10-17T10:00:00.000Z',
      paidAt: '2026-10-16T10:05:00.000Z',
      preimage: 'ef'.repeat(32),
    };
    expect(invoiceJson(full)).toEqual({
      paymentHash: hash,
      bolt11: 'lnbcrt1',
      amount: '5000',
      amountReceived: '5000',
      description: 'coffee',
      label: 'lp-1',
      status: 'paid',
      createdAt: full.createdAt,
      expiresAt: full.expiresAt,
      paidAt: full.paidAt,
    });
    const minimal: Invoice = {
      paymentHash: hash,
      bolt11: 'lnbcrt1',
      description: untrustedText(''),
      label: 'lp-2',
      status: 'unpaid',
      expiresAt: full.expiresAt,
    };
    expect(Object.keys(invoiceJson(minimal)).sort()).toEqual(
      ['bolt11', 'description', 'expiresAt', 'label', 'paymentHash', 'status'].sort(),
    );
  });
});
