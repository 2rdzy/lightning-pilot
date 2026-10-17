// The adapter contract suite: the behaviour every adapter must show, run against the fake adapter here and against
// real nodes on both regtest chains (tools/regtest). A new backend is done when the suite passes. Tests that move
// funds use the node's own wallet or a channel they open themselves, so the standard regtest channels stay as they
// are for the other tests.
import { createHash, randomBytes } from 'node:crypto';
import { bech32m } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  CAPABILITIES,
  checkInvoiceChain,
  decodeBolt11,
  msat,
  parsePaymentHash,
  readBolt11,
  type Chain,
  type Channel,
  type EventCursor,
  type Msat,
  type Network,
  type NodeAdapter,
  type NodeEvent,
  type Pubkey,
} from '@lightning-pilot/core';

export interface ContractEnv {
  chain: Chain;
  network: Network;
  // The adapter under test, with view and spend credentials.
  adapter: NodeAdapter;
  // The same node with the view credential only.
  viewOnly: NodeAdapter;
  // Another node the adapter's node already has a channel with: its key and `pubkey@host:port`.
  other: { pubkey: Pubkey; uri: string };
  // An invoice from another node that the adapter's node can route to.
  invoiceElsewhere(amountMsat: bigint): Promise<string>;
  // Whether that invoice has been paid, as the other node sees it.
  isPaidElsewhere(paymentHash: string): Promise<boolean>;
  // Another node pays this invoice (made by the adapter's node).
  payFromElsewhere(bolt11: string): Promise<void>;
  // A BOLT12 offer (any amount) from another node.
  offerElsewhere(): Promise<string>;
  // Mines blocks on the chain and waits until the adapter's node has seen them.
  mine(blocks: number): Promise<void>;
  // Invoice feature bit 512 on this chain profile (from @lightning-pilot/chain PROFILES, passed in so the kit does
  // not depend on the chain package).
  invoiceBit512: 'required' | 'refused';
}

const isHex = (s: string) => /^([0-9a-f]{2})*$/.test(s);
const versionTopBit = (rawHex: string) => (parseInt(rawHex.slice(6, 8), 16) & 0x80) !== 0;
const isMsat = (v: unknown) => typeof v === 'bigint' && v >= 0n;
const SAT_PER_VBYTE = /^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$/;
let counter = 0;
const label = (what: string) => `contract-${what}-${Date.now()}-${counter++}`;

async function until<T>(what: string, attempt: () => Promise<T | undefined>, seconds = 60): Promise<T> {
  for (let i = 0; i < seconds * 4; i++) {
    const value = await attempt();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${what}`);
}

// Reads events until one matches, within a time limit; returns it with its cursor.
async function nextEvent(
  iterator: AsyncIterator<{ event: NodeEvent; cursor: EventCursor }>,
  match: (e: NodeEvent) => boolean,
  seconds = 60,
): Promise<{ event: NodeEvent; cursor: EventCursor }> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), deadline - Date.now()));
    const next = await Promise.race([iterator.next(), timer]);
    if (next === 'timeout') break;
    if (next.done) throw new Error('event stream ended');
    if (match(next.value.event)) return next.value;
  }
  throw new Error('timeout waiting for event');
}

export function adapterContract(name: string, setup: () => Promise<ContractEnv>): void {
  describe(`adapter contract: ${name}`, () => {
    let env: ContractEnv;
    const ready = async () => (env ??= await setup());

    describe('node and chain', () => {
      it('node.getInfo reports a node of the expected network', async () => {
        const { adapter, network } = await ready();
        const info = await adapter.node.getInfo();
        expect(info.pubkey).toMatch(/^0[23][0-9a-f]{64}$/);
        expect(info.network).toBe(network);
        expect(info.blockHeight).toBeGreaterThan(0);
        expect(isHex(info.features)).toBe(true);
      });

      it('node.getStatus reports the access level and capabilities each credential allows', async () => {
        const { adapter, viewOnly } = await ready();
        const full = await adapter.node.getStatus();
        expect(full).toMatchObject({ reachable: true, credential: 'ok', accessLevel: 'standard' });
        for (const c of full.capabilities) expect(CAPABILITIES).toContain(c);
        for (const c of ['node.info', 'balances', 'channels.list', 'receive.bolt11', 'pay.bolt11', 'onchain.send']) {
          expect(full.capabilities, c).toContain(c);
        }
        const view = await viewOnly.node.getStatus();
        expect(view).toMatchObject({ reachable: true, credential: 'missing', accessLevel: 'read-only' });
        expect(view.capabilities).toContain('receive.bolt11');
        for (const c of ['pay.bolt11', 'pay.keysend', 'onchain.send', 'channels.open', 'peers.manage']) {
          expect(view.capabilities, c).not.toContain(c);
        }
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

      it('chain.getHeaderAt returns the block at a height, in the same format', async () => {
        const { adapter, chain } = await ready();
        const tip = await adapter.chain.getTipHeader();
        const at = await adapter.chain.getHeaderAt(tip.height);
        expect(at.height).toBe(tip.height);
        expect(at.raw.slice(0, 2 * (chain === 'blake2b' ? 164 : 80))).toBe(
          tip.raw.slice(0, 2 * (chain === 'blake2b' ? 164 : 80)),
        );
        const older = await adapter.chain.getHeaderAt(tip.height - 1);
        expect(versionTopBit(older.raw)).toBe(chain === 'blake2b');
      });

      it('chain.getFeeEstimates gives sat/vB rates as decimal strings', async () => {
        const { adapter } = await ready();
        const fees = await adapter.chain.getFeeEstimates();
        expect(fees.source).toBe('node');
        for (const rate of Object.values(fees.rates)) expect(rate).toMatch(SAT_PER_VBYTE);
        expect(Number(fees.rates.fastest)).toBeGreaterThanOrEqual(Number(fees.rates.economy));
      });

      it('chain.isSynced is true for a node at the tip', async () => {
        const { adapter } = await ready();
        expect(await adapter.chain.isSynced()).toBe(true);
      });

      it('plugin.listPlugins lists named plugins', async () => {
        const { adapter } = await ready();
        const plugins = await adapter.plugin.listPlugins();
        expect(plugins.length).toBeGreaterThan(0);
        for (const p of plugins) expect(p.name).not.toContain('/');
      });
    });

    describe('balances, peers and channels', () => {
      it('balance.getBalances returns non-negative msat amounts', async () => {
        const { adapter } = await ready();
        const b = await adapter.balance.getBalances();
        const amounts = [...Object.values(b.onchain), ...Object.values(b.lightning), b.pendingClose];
        for (const a of amounts) expect(isMsat(a)).toBe(true);
        expect(b.lightning.local > 0n).toBe(true);
      });

      it('peer.listPeers includes the other node, connected', async () => {
        const { adapter, other } = await ready();
        const peers = await adapter.peer.listPeers();
        const peer = peers.find((p) => p.pubkey === other.pubkey);
        expect(peer).toMatchObject({ connected: true });
        expect(peer?.numChannels).toBeGreaterThan(0);
      });

      it('channel.listChannels returns channels with our state group and the native state', async () => {
        const { adapter } = await ready();
        const page = await adapter.channel.listChannels({ limit: 200 });
        const active = page.items.filter((c) => c.state.group === 'active');
        expect(active.length).toBeGreaterThan(0);
        for (const c of active) {
          expect(c.state.native).toBe('CHANNELD_NORMAL');
          expect(c.capacity).toBe(c.local + c.remote);
          expect(isMsat(c.spendable) && isMsat(c.receivable)).toBe(true);
          expect(c.fundingOutpoint).toMatch(/^[0-9a-f]{64}:[0-9]+$/);
          expect(c.policy?.cltvDelta).toBeGreaterThan(0);
        }
      });

      it('channel lists page with an opaque cursor', async () => {
        const { adapter } = await ready();
        const all = await adapter.channel.listChannels({ limit: 200 });
        const first = await adapter.channel.listChannels({ limit: 1 });
        expect(first.items.length).toBe(1);
        if (all.items.length > 1) {
          expect(first.nextCursor).toBeDefined();
          const second = await adapter.channel.listChannels({ limit: 1, cursor: first.nextCursor ?? '' });
          expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
        }
        await expect(adapter.channel.listChannels({ cursor: 'not-a-cursor' })).rejects.toMatchObject({ sent: false });
        await expect(adapter.channel.listChannels({ limit: 201 })).rejects.toMatchObject({ sent: false });
      });

      it('channel.listClosedChannels and channel.listHtlcs return pages', async () => {
        const { adapter } = await ready();
        const closed = await adapter.channel.listClosedChannels();
        expect(Array.isArray(closed.items)).toBe(true);
        const htlcs = await adapter.channel.listHtlcs({ limit: 5 });
        expect(htlcs.items.length).toBeLessThanOrEqual(5);
        for (const h of htlcs.items) expect(['in', 'out']).toContain(h.direction);
      });

      it('peer.connect to a known peer succeeds; disconnect without force keeps a peer with channels', async () => {
        const { adapter, other } = await ready();
        expect(await adapter.peer.connect(other.uri)).toEqual({ pubkey: other.pubkey });
        await expect(adapter.peer.disconnect(other.pubkey)).rejects.toBeInstanceOf(AdapterError);
        const peer = (await adapter.peer.listPeers()).find((p) => p.pubkey === other.pubkey);
        expect(peer?.connected).toBe(true);
        await expect(adapter.peer.connect('not a node')).rejects.toMatchObject({ sent: false });
      });

      it('channel.setPolicy changes our fee policy (set back afterwards)', async () => {
        const { adapter } = await ready();
        const channel = (await adapter.channel.listChannels({ limit: 200 })).items.find(
          (c) => c.state.group === 'active' && c.policy,
        );
        if (!channel?.policy || !channel.shortChannelId) throw new Error('no active channel');
        const before = channel.policy;
        await adapter.channel.setPolicy({ channel: channel.shortChannelId, feePpm: before.feePpm + 1 });
        const changed = (await adapter.channel.listChannels({ limit: 200 })).items.find((c) => c.id === channel.id);
        expect(changed?.policy?.feePpm).toBe(before.feePpm + 1);
        await adapter.channel.setPolicy({
          channel: channel.id,
          feePpm: before.feePpm,
          baseFeeMsat: before.baseFeeMsat,
        });
      });

      it('opens a channel, sees it become active, closes it cooperatively', async () => {
        const { adapter, other, mine } = await ready();
        const opened = await adapter.channel.openChannel({ peer: other.pubkey, amount: msat(200_000_000n) });
        expect(opened.txid).toMatch(/^[0-9a-f]{64}$/);
        await mine(6);
        const find = async () =>
          (await adapter.channel.listChannels({ limit: 200 })).items.find((c: Channel) => c.id === opened.channelId);
        const active = await until('the new channel to be active', async () => {
          const c = await find();
          return c?.state.group === 'active' ? c : undefined;
        });
        expect(active.fundingOutpoint).toBe(`${opened.txid}:${opened.outnum}`);
        expect(active.capacity).toBe(200_000_000n);
        const closed = await adapter.channel.closeChannel({ channel: opened.channelId, force: false });
        expect(closed.type).toBe('mutual');
        if (closed.type === 'mutual') expect(closed.txids.length).toBeGreaterThan(0);
        await mine(1);
        await until('the channel to leave the normal state', async () => {
          const c = await find();
          return c === undefined || c.state.group !== 'active' ? true : undefined;
        });
      });

      it('refuses channel spends without a spend credential, before anything is sent', async () => {
        const { viewOnly, other } = await ready();
        const attempt = viewOnly.channel.openChannel({ peer: other.pubkey, amount: msat(100_000_000n) });
        await expect(attempt).rejects.toMatchObject({ code: 'permission_denied', sent: false, definitive: true });
        await expect(viewOnly.peer.connect(other.uri)).rejects.toMatchObject({ sent: false });
      });
    });

    describe('receive', () => {
      it('receive.createInvoice returns a signed invoice the full decoder accepts for this chain', async () => {
        const { adapter, network, invoiceBit512 } = await ready();
        const invoice = await adapter.receive.createInvoice({
          amount: msat(12_345n),
          description: 'contract',
          label: label('inv'),
        });
        const basics = readBolt11(invoice.bolt11);
        expect(basics.network).toBe(network);
        expect(basics.amount).toBe(12_345n);
        expect(basics.paymentHash).toBe(invoice.paymentHash);
        const full = decodeBolt11(invoice.bolt11);
        expect(full.payee).toBe((await adapter.node.getInfo()).pubkey);
        expect(full.description).toBe('contract');
        expect(() => checkInvoiceChain(full, { network, invoiceBit512 })).not.toThrow();
        expect(invoice.status).toBe('unpaid');
      });

      it('creates an invoice for any amount', async () => {
        const { adapter } = await ready();
        const invoice = await adapter.receive.createInvoice({ description: 'any', label: label('any') });
        expect(readBolt11(invoice.bolt11).amount).toBeUndefined();
        expect(invoice.amount).toBeUndefined();
      });

      it('receive.getInvoice and listInvoices find invoices, oldest first, page by page', async () => {
        const { adapter } = await ready();
        const a = await adapter.receive.createInvoice({ amount: msat(1_000n), description: 'a', label: label('la') });
        const b = await adapter.receive.createInvoice({ amount: msat(2_000n), description: 'b', label: label('lb') });
        expect(await adapter.receive.getInvoice(a.paymentHash)).toMatchObject({
          paymentHash: a.paymentHash,
          amount: 1_000n,
        });
        expect(await adapter.receive.getInvoice(parsePaymentHash('cd'.repeat(32)))).toBeUndefined();
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await adapter.receive.listInvoices({ limit: 200, ...(cursor ? { cursor } : {}) });
          seen.push(...page.items.map((i) => i.paymentHash));
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen.indexOf(a.paymentHash)).toBeLessThan(seen.indexOf(b.paymentHash));
        expect(seen.indexOf(a.paymentHash)).toBeGreaterThanOrEqual(0);
      });

      it('receive.newAddress gives a bech32 or taproot address of the network', async () => {
        const { adapter, network } = await ready();
        const hrp = network === 'mainnet' ? 'bc1' : network === 'regtest' ? 'bcrt1' : 'tb1';
        const segwit = await adapter.receive.newAddress('p2wpkh');
        expect(segwit.address.startsWith(`${hrp}q`)).toBe(true);
        const taproot = await adapter.receive.newAddress('p2tr');
        expect(taproot.address.startsWith(`${hrp}p`)).toBe(true);
      });

      it('onchain.ownsAddress knows the addresses its wallet issued and no others', async () => {
        const { adapter, network } = await ready();
        const hrp = network === 'mainnet' ? 'bc' : network === 'regtest' ? 'bcrt' : 'tb';
        expect(await adapter.onchain.ownsAddress((await adapter.receive.newAddress('p2wpkh')).address)).toBe(true);
        expect(await adapter.onchain.ownsAddress((await adapter.receive.newAddress('p2tr')).address)).toBe(true);
        const stranger = bech32m.encode(hrp, [1, ...bech32m.toWords(randomBytes(32))]);
        expect(await adapter.onchain.ownsAddress(stranger)).toBe(false);
        // The node's default shutdown address of an open channel is its own (a close with no destination is free).
        for (const channel of (await adapter.channel.listChannels({ limit: 200 })).items)
          if (channel.closeTo !== undefined && channel.state.group === 'active')
            expect(await adapter.onchain.ownsAddress(channel.closeTo), channel.id).toBe(true);
      });

      it('creates, lists and disables an offer', async () => {
        const { adapter } = await ready();
        const offer = await adapter.receive.createOffer({ description: 'contract offer', label: label('offer') });
        expect(offer.bolt12.startsWith('lno1')).toBe(true);
        expect(offer.active).toBe(true);
        expect((await adapter.receive.listOffers()).map((o) => o.id)).toContain(offer.id);
        expect(await adapter.receive.disableOffer(offer.id)).toMatchObject({ id: offer.id, active: false });
      });
    });

    describe('pay', () => {
      it('pay.pay pays an invoice on another node and returns its preimage', async () => {
        const { adapter, invoiceElsewhere, isPaidElsewhere } = await ready();
        const bolt11 = await invoiceElsewhere(21_000n);
        const payLabel = label('pay');
        const result = await adapter.pay.pay({ bolt11, maxFee: msat(10_000n), label: payLabel, retryForSeconds: 30 });
        const hash = createHash('sha256').update(Buffer.from(result.preimage, 'hex')).digest('hex');
        expect(result.paymentHash).toBe(hash);
        expect(result.paymentHash).toBe(readBolt11(bolt11).paymentHash);
        expect(result.amount).toBe(21_000n);
        expect(result.amountSent >= result.amount).toBe(true);
        expect(await isPaidElsewhere(result.paymentHash)).toBe(true);
        const record = await adapter.pay.getPayment(result.paymentHash);
        expect(record?.status).toBe('succeeded');
        expect(record?.label).toBe(payLabel);
        const byLabel = await adapter.pay.listByLabel(payLabel);
        expect(byLabel.map((p) => p.paymentHash)).toEqual([result.paymentHash]);
      });

      it('pay.listPayments lists payments oldest first, with an opaque cursor', async () => {
        const { adapter } = await ready();
        const first = await adapter.pay.listPayments({ limit: 1 });
        expect(first.items.length).toBe(1);
        expect(first.items[0]?.status).toMatch(/^(pending|succeeded|failed)$/);
        if (first.nextCursor) {
          const second = await adapter.pay.listPayments({ limit: 1, cursor: first.nextCursor });
          expect(second.items[0]?.createdAt && first.items[0]?.createdAt).toBeTruthy();
          expect(Date.parse(second.items[0]?.createdAt ?? '')).toBeGreaterThanOrEqual(
            Date.parse(first.items[0]?.createdAt ?? ''),
          );
        }
      });

      it('pay.keysend pays a node by its key, found afterwards by label', async () => {
        const { adapter, other } = await ready();
        const sendLabel = label('keysend');
        const result = await adapter.pay.keysend({
          destination: other.pubkey,
          amount: msat(3_000n),
          maxFee: msat(10_000n),
          label: sendLabel,
          retryForSeconds: 30,
        });
        expect(result.amount).toBe(3_000n);
        const found = await adapter.pay.listByLabel(sendLabel);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ paymentHash: result.paymentHash, status: 'succeeded' });
      });

      it('pay.getPayment knows nothing of a payment hash never paid', async () => {
        const { adapter } = await ready();
        expect(await adapter.pay.getPayment(parsePaymentHash('ab'.repeat(32)))).toBeUndefined();
        expect(await adapter.pay.listByLabel(label('never'))).toEqual([]);
      });

      it('pay.previewRoute estimates a route to the other node', async () => {
        const { adapter, other } = await ready();
        const route = await adapter.pay.previewRoute({
          destination: other.pubkey,
          amount: msat(10_000n),
          maxFee: msat(10_000n),
          finalCltv: 18,
        });
        expect(route?.hops).toBeGreaterThanOrEqual(1);
        expect(isMsat(route?.fee)).toBe(true);
      });

      it('pay.decode reports what the node reads in an invoice', async () => {
        const { adapter, invoiceElsewhere } = await ready();
        const bolt11 = await invoiceElsewhere(4_000n);
        const decoded = await adapter.pay.decode(bolt11);
        expect(decoded).toMatchObject({ valid: true, amount: 4_000n, paymentHash: readBolt11(bolt11).paymentHash });
        if (decoded.payee !== undefined) expect(decoded.payee).toBe(decodeBolt11(bolt11).payee);
      });

      it("pay.fetchOfferInvoice gets an invoice from another node's offer", async () => {
        const { adapter, offerElsewhere } = await ready();
        const offer = await offerElsewhere();
        const invoice = await adapter.pay.fetchOfferInvoice(offer, msat(5_000n));
        expect(invoice.startsWith('lni1')).toBe(true);
      });

      it('refuses to pay without a spend credential, before anything is sent', async () => {
        const { viewOnly, invoiceElsewhere, other } = await ready();
        const bolt11 = await invoiceElsewhere(1_000n);
        const attempt = viewOnly.pay.pay({ bolt11, maxFee: msat(1_000n), label: label('ro'), retryForSeconds: 5 });
        await expect(attempt).rejects.toBeInstanceOf(AdapterError);
        await expect(attempt).rejects.toMatchObject({ sent: false, definitive: true });
        const keysend = viewOnly.pay.keysend({
          destination: other.pubkey,
          amount: msat(1_000n),
          maxFee: msat(1_000n),
          label: label('ro-keysend'),
          retryForSeconds: 5,
        });
        await expect(keysend).rejects.toMatchObject({ sent: false, definitive: true });
      });
    });

    describe('on-chain and routing', () => {
      it('onchain.listUtxos and listTransactions show the wallet', async () => {
        const { adapter } = await ready();
        const utxos = await adapter.onchain.listUtxos();
        expect(utxos.some((u) => u.status === 'confirmed' && isMsat(u.amount))).toBe(true);
        const txs = await adapter.onchain.listTransactions({ limit: 200 });
        expect(txs.items.length).toBeGreaterThan(0);
        for (const tx of txs.items) {
          expect(tx.txid).toMatch(/^[0-9a-f]{64}$/);
          expect(tx.confirmations).toBeGreaterThanOrEqual(0);
        }
      });

      it('prepares, discards, unreserves and sends an on-chain payment to its own wallet', async () => {
        const { adapter, mine } = await ready();
        const to = (await adapter.receive.newAddress('p2wpkh')).address;
        const reservedNow = async () => (await adapter.onchain.listUtxos()).filter((u) => u.reserved).length;
        const before = await reservedNow();
        const outputs = [{ address: to, amount: msat(10_000_000n) }];

        const discarded = await adapter.onchain.prepare({ outputs });
        expect(discarded.txid).toMatch(/^[0-9a-f]{64}$/);
        expect(await reservedNow()).toBeGreaterThan(before);
        await adapter.onchain.discard(discarded.txid);
        expect(await reservedNow()).toBe(before);

        const released = await adapter.onchain.prepare({ outputs, feeRate: '2' });
        await adapter.onchain.unreserve(released.psbt);
        expect(await reservedNow()).toBe(before);
        // The node still knows the prepared transaction; forget it so its inputs are not reserved again later.
        await adapter.onchain.discard(released.txid).catch(() => undefined);

        const prepared = await adapter.onchain.prepare({ outputs });
        const sent = await adapter.onchain.send(prepared.txid);
        expect(sent.txid).toBe(prepared.txid);
        await mine(1);
        const txs = await adapter.onchain.listTransactions({ limit: 200 });
        expect(txs.items.map((t) => t.txid)).toContain(sent.txid);
      });

      it('refuses on-chain spends without a spend credential, before anything is sent', async () => {
        const { viewOnly } = await ready();
        const to = (await viewOnly.receive.newAddress('p2wpkh')).address;
        const attempt = viewOnly.onchain.prepare({ outputs: [{ address: to, amount: msat(1_000_000n) }] });
        await expect(attempt).rejects.toMatchObject({ code: 'permission_denied', sent: false, definitive: true });
      });

      it('routing.listForwards returns a page of forwards', async () => {
        const { adapter } = await ready();
        const page = await adapter.routing.listForwards({ limit: 10 });
        for (const f of page.items) {
          expect(isMsat(f.amountIn)).toBe(true);
          expect(f.inChannel).toMatch(/^[0-9]+x[0-9]+x[0-9]+$/);
        }
      });
    });

    describe('events', () => {
      it('streams an invoice payment and new blocks, and resumes from a cursor without loss or repeat', async () => {
        const { adapter, payFromElsewhere, mine } = await ready();
        const controller = new AbortController();
        const iterator = adapter.events.subscribe(undefined, controller.signal)[Symbol.asyncIterator]();
        try {
          const amount: Msat = msat(7_000n);
          const invoice = await adapter.receive.createInvoice({ amount, description: 'event', label: label('ev') });
          // The stream starts at the present when it is first read: start reading, give it time to reach the node,
          // then pay.
          const pending = iterator.next();
          await new Promise((r) => setTimeout(r, 1000));
          await payFromElsewhere(invoice.bolt11);
          const isOurs = (e: NodeEvent) => e.type === 'invoice.paid' && e.data.paymentHash === invoice.paymentHash;
          const first = await pending;
          if (first.done) throw new Error('event stream ended');
          const paidEvent = isOurs(first.value.event) ? first.value : await nextEvent(iterator, isOurs);
          expect(paidEvent.event).toMatchObject({
            type: 'invoice.paid',
            data: { paymentHash: invoice.paymentHash, amountReceived: amount },
          });
          const tip = (await adapter.node.getInfo()).blockHeight;
          await mine(1);
          const block = await nextEvent(iterator, (e) => e.type === 'block.new');
          expect(block.event).toEqual({ type: 'block.new', data: { height: tip + 1 } });

          // From the cursor of the payment: the block comes again, the payment does not.
          const resumed = adapter.events.subscribe(paidEvent.cursor, controller.signal)[Symbol.asyncIterator]();
          const again = await nextEvent(resumed, (e) => e.type === 'block.new' || e.type === 'invoice.paid');
          expect(again.event).toEqual({ type: 'block.new', data: { height: tip + 1 } });
          await expect(
            (async () => {
              const r = adapter.events.subscribe('bad-cursor', controller.signal)[Symbol.asyncIterator]();
              await r.next();
            })(),
          ).rejects.toMatchObject({ sent: false });
        } finally {
          controller.abort();
        }
      });
    });
  });
}
