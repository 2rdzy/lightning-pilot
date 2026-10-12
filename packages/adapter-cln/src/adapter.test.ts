// Unit tests of the CLN adapter's logic with recorded node replies (shapes as returned by clnrest v26.06.9 on the
// regtest chains). The HTTPS client is tested in client.test.ts, the whole adapter against real nodes in
// tools/regtest.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AdapterError, msat, parseJsonLossless, parsePaymentHash } from '@lightning-pilot/core';
import fixtures from '../../core/src/decode/fixtures/regtest-invoices.json' with { type: 'json' };
import { createClnAdapter, type Transport } from './adapter.ts';

const ID = '024470f8943559c516abe722f8919fa81fec56ede15eb46ef557b0a0b15872a399';
const PREIMAGE = '11'.repeat(32);
const PREIMAGE_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');
// A real regtest invoice (committed fixture) and the payment hash it carries.
const INVOICE = fixtures.invoices[0]?.bolt11 ?? '';
const INVOICE_HASH = fixtures.invoices[0]?.paymentHash ?? '';

type Reply = unknown | ((params: Record<string, unknown>) => unknown);

// Plays replies by command; a reply that is an Error (or a function throwing one) is thrown.
function recorded(replies: Record<string, Reply>) {
  const calls: { command: string; params: Record<string, unknown>; rune: string }[] = [];
  const transport: Transport = {
    call: async (command, params, options) => {
      calls.push({ command, params, rune: options.rune });
      const reply = replies[command];
      const value = typeof reply === 'function' ? (reply as (p: Record<string, unknown>) => unknown)(params) : reply;
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`no recorded reply for ${command}`);
      return typeof value === 'string' ? parseJsonLossless(value) : value;
    },
  };
  return { transport, calls };
}

// spendRune null: a node added without a spend credential.
function adapter(replies: Record<string, Reply>, spendRune: string | null = 'SPEND') {
  const r = recorded(replies);
  return {
    ...r,
    adapter: createClnAdapter({
      url: 'https://localhost:1',
      caCertificate: '',
      serverName: 'localhost',
      viewRune: 'VIEW',
      ...(spendRune === null ? {} : { spendRune }),
      transport: r.transport,
    }),
  };
}

const getinfo = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: ID,
    alias: 'blake2b-cln-a‮',
    color: '024470',
    version: 'v26.06.9-blake2b.7',
    network: 'regtest',
    blockheight: 126,
    num_peers: 2,
    num_active_channels: 2,
    num_pending_channels: 0,
    num_inactive_channels: 0,
    our_features: { init: '0200' },
    ...extra,
  });

const nodeError = (nodeCode: number) =>
  new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode, detail: 'Failed' });

describe('cln adapter with recorded replies', () => {
  it('maps getinfo, stripping unsafe characters from the alias', async () => {
    const { adapter: a, calls } = adapter({ getinfo: getinfo() });
    const info = await a.node.getInfo();
    expect(info).toMatchObject({
      pubkey: ID,
      alias: 'blake2b-cln-a',
      network: 'regtest',
      synced: true,
      features: '0200',
    });
    expect(calls[0]?.rune).toBe('VIEW');
  });

  it('maps mainnet and unknown networks, a missing alias and sync warnings', async () => {
    const mainnet = await adapter({
      getinfo: getinfo({ network: 'bitcoin', alias: undefined }),
    }).adapter.node.getInfo();
    expect(mainnet).toMatchObject({ network: 'mainnet', networkRaw: 'bitcoin', alias: '' });
    const unknown = await adapter({ getinfo: getinfo({ network: 'liquid' }) }).adapter.node.getInfo();
    expect(unknown.network).toBe('unknown');
    const behind = await adapter({
      getinfo: getinfo({ warning_bitcoind_sync: 'Bitcoind is not up-to-date' }),
    }).adapter.node.getInfo();
    expect(behind.synced).toBe(false);
    const ldBehind = await adapter({
      getinfo: getinfo({ warning_lightningd_sync: 'Still loading' }),
    }).adapter.node.getInfo();
    expect(ldBehind.synced).toBe(false);
  });

  it('refuses a reply that does not match the schema', async () => {
    const attempt = adapter({ getinfo: getinfo({ id: 'not-a-key' }) }).adapter.node.getInfo();
    await expect(attempt).rejects.toMatchObject({ code: 'node_bad_response', sent: true, definitive: false });
  });

  it('reads the tip block at the height getinfo reports', async () => {
    const { adapter: a, calls } = adapter({
      getinfo: getinfo(),
      getrawblockbyheight: '{"blockhash":"00","block":"000000a001"}',
    });
    expect(await a.chain.getTipHeader()).toEqual({ height: 126, raw: '000000a001' });
    expect(calls[1]?.params).toEqual({ height: 126 });
  });

  it('sums balances by output status and channel state, exactly', async () => {
    const { adapter: a } = adapter({
      listfunds: `{"outputs":[
        {"amount_msat":9007199254740993,"status":"confirmed"},
        {"amount_msat":1000,"status":"unconfirmed"},
        {"amount_msat":500,"status":"confirmed","reserved":true},
        {"amount_msat":7,"status":"spent","reserved":true}]}`,
      listpeerchannels: `{"channels":[
        {"state":"CHANNELD_NORMAL","peer_connected":true,"to_us_msat":600,"total_msat":1000,"spendable_msat":500,"receivable_msat":300},
        {"state":"CHANNELD_NORMAL","peer_connected":false,"to_us_msat":100,"total_msat":200,"spendable_msat":90,"receivable_msat":80},
        {"state":"CHANNELD_AWAITING_SPLICE","peer_connected":true},
        {"state":"ONCHAIN","to_us_msat":42},
        {"state":"CLOSINGD_COMPLETE"},
        {"state":"DUALOPEND_AWAITING_LOCKIN","to_us_msat":5}]}`,
    });
    expect(await a.balance.getBalances()).toEqual({
      onchain: { confirmed: 9007199254740993n, unconfirmed: 1000n, reserved: 500n },
      lightning: { local: 700n, spendable: 500n, remote: 500n, receivable: 300n },
      pendingClose: 42n,
    });
  });

  it('creates an invoice with or without an expiry', async () => {
    const reply = `{"bolt11":"lnbcrt1","payment_hash":"${PREIMAGE_HASH}","expires_at":1800000000}`;
    const { adapter: a, calls } = adapter({ invoice: reply });
    const invoice = await a.receive.createInvoice({ amount: msat(5000n), description: 'coffee', label: 'l1' });
    expect(invoice).toMatchObject({ paymentHash: PREIMAGE_HASH, amount: 5000n, status: 'unpaid', label: 'l1' });
    expect(invoice.expiresAt).toBe(new Date(1800000000 * 1000).toISOString());
    await a.receive.createInvoice({ amount: msat(1n), description: '', label: 'l2', expirySeconds: 60 });
    expect(calls[0]?.params).toEqual({ amount_msat: 5000n, label: 'l1', description: 'coffee' });
    expect(calls[1]?.params).toMatchObject({ expiry: 60 });
  });

  describe('getPayment', () => {
    const hash = parsePaymentHash(PREIMAGE_HASH);
    const parts = (...p: Record<string, unknown>[]) => ({
      payments: p.map((x) => ({ payment_hash: PREIMAGE_HASH, ...x })),
    });

    it('knows nothing of an unknown hash', async () => {
      expect(await adapter({ listsendpays: { payments: [] } }).adapter.pay.getPayment(hash)).toBeUndefined();
    });

    it('reports success with the sum sent, the preimage and the label', async () => {
      const reply = parts(
        { status: 'complete', amount_sent_msat: 700n, payment_preimage: PREIMAGE, label: 'intent-1' },
        { status: 'complete', amount_sent_msat: 300n },
        { status: 'failed' },
      );
      expect(await adapter({ listsendpays: reply }).adapter.pay.getPayment(hash)).toEqual({
        paymentHash: hash,
        status: 'succeeded',
        amountSent: 1000n,
        preimage: PREIMAGE,
        label: 'intent-1',
      });
      const bare = await adapter({ listsendpays: parts({ status: 'complete' }) }).adapter.pay.getPayment(hash);
      expect(bare).toEqual({ paymentHash: hash, status: 'succeeded', amountSent: 0n });
    });

    it('reports pending, failed, and never reads an unknown part status as failed', async () => {
      const get = (...p: Record<string, unknown>[]) =>
        adapter({ listsendpays: parts(...p) }).adapter.pay.getPayment(hash);
      expect((await get({ status: 'pending' }, { status: 'failed' }))?.status).toBe('pending');
      expect(await get({ status: 'failed' })).toEqual({ paymentHash: hash, status: 'failed' });
      expect((await get({ status: 'failed' }, { status: 'mystery' }))?.status).toBe('pending');
    });
  });

  describe('pay', () => {
    const request = { bolt11: INVOICE, maxFee: msat(5000n), label: 'intent-1', retryForSeconds: 60 };

    it('sends xpay with the spend rune and derives the payment hash from the preimage', async () => {
      const { adapter: a, calls } = adapter({
        xpay: `{"payment_preimage":"${PREIMAGE}","amount_msat":1000,"amount_sent_msat":1003,"failed_parts":0,"successful_parts":1}`,
      });
      expect(await a.pay.pay(request)).toEqual({
        paymentHash: PREIMAGE_HASH,
        preimage: PREIMAGE,
        amount: 1000n,
        amountSent: 1003n,
        fee: 3n,
      });
      expect(calls[0]).toEqual({
        command: 'xpay',
        rune: 'SPEND',
        params: { invstring: INVOICE, maxfee: 5000n, retry_for: 60, label: 'intent-1' },
      });
    });

    it('reports no fee when the node reports less sent than the amount', async () => {
      const { adapter: a } = adapter({
        xpay: { payment_preimage: PREIMAGE, amount_msat: 1000n, amount_sent_msat: 999n },
      });
      expect((await a.pay.pay(request)).fee).toBe(0n);
    });

    it('refuses to pay without a spend rune, before anything is sent', async () => {
      const { adapter: a, calls } = adapter({}, null);
      await expect(a.pay.pay(request)).rejects.toMatchObject({
        code: 'permission_denied',
        sent: false,
        definitive: true,
      });
      expect(calls).toEqual([]);
    });

    it('turns a no-route failure into a definitive failure once listsendpays shows nothing went out', async () => {
      for (const listsendpays of [
        { payments: [] },
        { payments: [{ payment_hash: '00'.repeat(32), status: 'pending' }] },
      ]) {
        const { adapter: a } = adapter({ xpay: nodeError(205), listsendpays });
        await expect(a.pay.pay(request)).rejects.toMatchObject({
          code: 'payment_failed',
          definitive: true,
          nodeCode: 205,
        });
      }
      const failedParts = adapter({ xpay: nodeError(207), listsendpays: { payments: [] } });
      await expect(failedParts.adapter.pay.pay(request)).rejects.toMatchObject({ code: 'payment_failed' });
    });

    it('keeps a no-route failure not definitive when a part is pending or the check fails', async () => {
      const pending = adapter({
        xpay: nodeError(205),
        listsendpays: { payments: [{ payment_hash: INVOICE_HASH, status: 'pending' }] },
      });
      await expect(pending.adapter.pay.pay(request)).rejects.toMatchObject({ code: 'node_error', definitive: false });
      const broken = adapter({ xpay: nodeError(205), listsendpays: new Error('connection reset') });
      await expect(broken.adapter.pay.pay(request)).rejects.toMatchObject({ code: 'node_error', definitive: false });
      const unreadable = adapter({ xpay: nodeError(205), listsendpays: { payments: [] } });
      await expect(unreadable.adapter.pay.pay({ ...request, bolt11: 'garbage' })).rejects.toMatchObject({
        definitive: false,
      });
    });

    it('passes other errors through unchanged', async () => {
      for (const error of [
        nodeError(209),
        new AdapterError({ code: 'node_unreachable', sent: false, definitive: false }),
        new AdapterError({ code: 'node_unreachable', sent: true, definitive: false }),
        new Error('bug'),
      ]) {
        await expect(adapter({ xpay: error }).adapter.pay.pay(request)).rejects.toBe(error);
      }
    });
  });
});
