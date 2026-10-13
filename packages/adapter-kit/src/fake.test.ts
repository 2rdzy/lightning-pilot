import { describe, expect, it } from 'vitest';
import { msat, readBolt11 } from '@lightning-pilot/core';
import { FakeAdapter } from './fake.ts';

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
