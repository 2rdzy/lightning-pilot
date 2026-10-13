import { msat, type Chain } from '@lightning-pilot/core';
import { adapterContract } from './contract.ts';
import { FakeAdapter, FakeNetwork } from './fake.ts';

for (const chain of ['blake2b', 'bitcoin'] as Chain[]) {
  adapterContract(`fake (${chain})`, async () => {
    const world = new FakeNetwork();
    const adapter = new FakeAdapter({ chain, world });
    const viewOnly = new FakeAdapter({ chain, world, canSpend: false });
    const other = new FakeAdapter({ chain, world });
    adapter.addChannel(other.pubkey);
    other.addChannel(adapter.pubkey);
    return {
      chain,
      network: 'regtest',
      adapter,
      viewOnly,
      other: { pubkey: other.pubkey, uri: `${other.pubkey}@127.0.0.1:9735` },
      invoiceElsewhere: async (amount) =>
        (await other.receive.createInvoice({ amount: msat(amount), description: 'x', label: `l${Math.random()}` }))
          .bolt11,
      isPaidElsewhere: async (hash) => other.isPaid(hash),
      payFromElsewhere: async (bolt11) => {
        await other.pay.pay({ bolt11, maxFee: msat(1_000n), label: `p${Math.random()}`, retryForSeconds: 5 });
      },
      offerElsewhere: async () => (await other.receive.createOffer({ description: 'offer' })).bolt12,
      mine: async (blocks) => adapter.mine(blocks),
      invoiceBit512: chain === 'blake2b' ? 'required' : 'refused',
    };
  });
}
