import { msat, type Chain } from '@lightning-pilot/core';
import { adapterContract } from './contract.ts';
import { FakeAdapter, FakeNetwork } from './fake.ts';

for (const chain of ['blake2b', 'bitcoin'] as Chain[]) {
  adapterContract(`fake (${chain})`, async () => {
    const world = new FakeNetwork();
    const adapter = new FakeAdapter({ chain, world });
    const viewOnly = new FakeAdapter({ chain, world, canSpend: false });
    const other = new FakeAdapter({ chain, world });
    return {
      chain,
      network: 'regtest',
      adapter,
      viewOnly,
      invoiceElsewhere: async (amount) =>
        (await other.receive.createInvoice({ amount: msat(amount), description: 'x', label: `l${Math.random()}` }))
          .bolt11,
      isPaidElsewhere: async (hash) => other.isPaid(hash),
    };
  });
}
