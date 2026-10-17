// The complete adapter's ports with recorded replies (field shapes from CLN v26.06 doc/schemas and the regtest
// nodes): what is sent, how replies map, and how node errors are classified (domain and adapter §5.3).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AdapterError, msat, parsePaymentHash, parsePubkey, parseTxid } from '@lightning-pilot/core';
import fixtures from '../../core/src/decode/fixtures/regtest-invoices.json' with { type: 'json' };
import { perkbToSatPerVbyte, satPerVbyteToPerkb, wholeSats } from './context.ts';
import { adapter, CHANNEL_ID, getinfo, HASH, ID, nodeError, PEER, peerChannel, TXID } from './fixtures/recorded.ts';
import { channelState, closeCause } from './states.ts';

const PREIMAGE = '22'.repeat(32);
const PREIMAGE_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');
const timeout = () => new AdapterError({ code: 'node_unreachable', sent: true, definitive: false, detail: 'timeout' });

describe('conversions', () => {
  it('turns perkb into exact sat/vB strings and back', () => {
    expect(perkbToSatPerVbyte(1012)).toBe('1.012');
    expect(perkbToSatPerVbyte(2000)).toBe('2');
    expect(perkbToSatPerVbyte(2500)).toBe('2.5');
    expect(perkbToSatPerVbyte(7)).toBe('0.007');
    expect(satPerVbyteToPerkb('1.012')).toBe('1012perkb');
    expect(satPerVbyteToPerkb('2.5')).toBe('2500perkb');
    expect(satPerVbyteToPerkb('20')).toBe('20000perkb');
    for (const bad of ['', '1.0001', '-1', '1e3', 'fast']) {
      expect(() => satPerVbyteToPerkb(bad), bad).toThrow(AdapterError);
    }
  });

  it('accepts only whole satoshis for funding amounts', () => {
    expect(wholeSats(msat(5_000n))).toBe(5n);
    expect(() => wholeSats(msat(5_001n))).toThrow(AdapterError);
  });

  it('maps every CLN channel state to a group, and unknown ones to unknown', () => {
    expect(channelState('CHANNELD_NORMAL', true).group).toBe('active');
    expect(channelState('CHANNELD_NORMAL', false).group).toBe('inactive');
    for (const s of ['OPENINGD', 'DUALOPEND_OPEN_INIT', 'DUALOPEND_OPEN_COMMITTED', 'DUALOPEND_OPEN_COMMIT_READY']) {
      expect(channelState(s, true).group).toBe('opening');
    }
    for (const s of ['DUALOPEND_AWAITING_LOCKIN', 'CHANNELD_AWAITING_LOCKIN'])
      expect(channelState(s, true).group).toBe('opening');
    expect(channelState('CHANNELD_AWAITING_SPLICE', true).group).toBe('splicing');
    for (const s of ['CHANNELD_SHUTTING_DOWN', 'CLOSINGD_SIGEXCHANGE', 'CLOSINGD_COMPLETE', 'AWAITING_UNILATERAL']) {
      expect(channelState(s, true).group).toBe('closing');
    }
    for (const s of ['FUNDING_SPEND_SEEN', 'ONCHAIN']) expect(channelState(s, false).group).toBe('closing');
    expect(channelState('CLOSED', false).group).toBe('closed');
    expect(channelState('SPLICING_WITH_STYLE', true)).toEqual({
      group: 'unknown',
      native: 'SPLICING_WITH_STYLE',
      nativeLabel: 'SPLICING_WITH_STYLE',
    });
    expect([closeCause('user'), closeCause('remote'), closeCause('protocol'), closeCause('new')]).toEqual([
      'local',
      'remote',
      'unknown',
      'unknown',
    ]);
    expect(closeCause('onchain')).toBe('onchain');
  });
});

describe('node status', () => {
  // checkrune answers as the regtest node does: valid for the methods in the rune, 1502 (HTTP 500) otherwise.
  const runes: Record<string, (method: string) => boolean> = {
    VIEW: (m) => !['xpay', 'createrune', 'signmessage', 'stop'].includes(m) && !m.startsWith('tx'),
    SPEND: (m) =>
      [
        'xpay',
        'xkeysend',
        'txprepare',
        'txsend',
        'txdiscard',
        'unreserveinputs',
        'fundchannel',
        'close',
        'connect',
        'disconnect',
        'setchannel',
      ].includes(m),
    FULL: (m) => runes.SPEND?.(m) === true || m === 'signmessage' || m === 'stop',
    ADMIN: () => true,
    NARROW: (m) => m === 'xpay',
    REVOKED: () => false,
  };
  const checkrune = (p: Record<string, unknown>) =>
    runes[String(p.rune)]?.(String(p.method)) ? { valid: true } : nodeError(1502, 'Not permitted');
  const plugins = { command: 'list', plugins: [{ name: '/usr/libexec/c-lightning/plugins/bookkeeper', active: true }] };

  it('reports a standard credential with every capability its runes allow', async () => {
    const { adapter: a, calls } = adapter({ getinfo: getinfo(), checkrune, plugin: plugins });
    const status = await a.node.getStatus();
    expect(status).toMatchObject({ reachable: true, credential: 'ok', accessLevel: 'standard' });
    expect(status.lastSeenAt).toBeDefined();
    expect(status.capabilities).toEqual(expect.arrayContaining(['node.info', 'pay.bolt11', 'accounting.bookkeeper']));
    // The spend rune is a parameter of checkrune, sent under the view rune; never a header.
    expect(calls.every((c) => c.rune === 'VIEW')).toBe(true);
    expect(calls.find((c) => c.command === 'checkrune' && c.params.method === 'plugin')?.params.params).toEqual({
      subcommand: 'list',
    });
  });

  it('tells full management, admin, narrow, revoked and missing spend credentials apart', async () => {
    const level = async (spend: string | null) =>
      await adapter({ getinfo: getinfo(), checkrune, plugin: plugins }, spend).adapter.node.getStatus();
    expect((await level('FULL')).accessLevel).toBe('full');
    expect((await level('ADMIN')).accessLevel).toBe('admin');
    const narrow = await level('NARROW');
    expect(narrow).toMatchObject({ credential: 'ok', accessLevel: 'standard' });
    expect(narrow.capabilities).toContain('pay.bolt11');
    expect(narrow.capabilities).not.toContain('pay.keysend');
    expect(await level('REVOKED')).toMatchObject({ credential: 'revoked', accessLevel: 'read-only' });
    const none = await level(null);
    expect(none).toMatchObject({ credential: 'missing', accessLevel: 'read-only' });
    expect(none.capabilities).not.toContain('channels.open');
  });

  it('leaves out the bookkeeper when the plugin is not running', async () => {
    const status = await adapter({
      getinfo: getinfo(),
      checkrune,
      plugin: { command: 'list', plugins: [] },
    }).adapter.node.getStatus();
    expect(status.capabilities).not.toContain('accounting.bookkeeper');
  });

  it('reports an unreachable node, and a refused view rune as reachable with nothing allowed', async () => {
    const down = await adapter({
      getinfo: new AdapterError({ code: 'node_unreachable', sent: false, definitive: false }),
    }).adapter.node.getStatus();
    expect(down).toMatchObject({
      reachable: false,
      credential: 'unknown',
      viewCredential: 'unknown',
      spendCredential: 'unknown',
      accessLevel: 'read-only',
      capabilities: [],
    });
    const refused = await adapter(
      { getinfo: new AdapterError({ code: 'node_credential_revoked', sent: true, definitive: true }) },
      null,
    ).adapter.node.getStatus();
    expect(refused).toMatchObject({ reachable: true, credential: 'missing', capabilities: [] });
  });

  it('passes on node errors other than a refusal', async () => {
    const attempt = adapter({ getinfo: getinfo(), checkrune: nodeError(-1) }).adapter.node.getStatus();
    await expect(attempt).rejects.toMatchObject({ nodeCode: -1 });
    await expect(adapter({ getinfo: new Error('bug') }).adapter.node.getStatus()).rejects.toThrow('bug');
  });
});

describe('chain', () => {
  it('reads a block at a height and refuses a bad height before sending', async () => {
    const { adapter: a, calls } = adapter({ getrawblockbyheight: { block: '00000020ff' } });
    expect(await a.chain.getHeaderAt(5)).toEqual({ height: 5, raw: '00000020ff' });
    expect(() => a.chain.getHeaderAt(-1)).toThrow(AdapterError);
    expect(calls).toHaveLength(1);
  });

  it('maps feerates perkb to the five rates and the node-specific ones', async () => {
    const feerates = {
      perkb: {
        min_acceptable: 1012,
        estimates: [
          { blockcount: 12, feerate: 3000 },
          { blockcount: 2, feerate: 20000 },
          { blockcount: 6, feerate: 8000 },
          { blockcount: 100, feerate: 1500 },
        ],
        opening: 8000,
        mutual_close: 3000,
        unilateral_close: 20000,
      },
    };
    const { adapter: a, calls } = adapter({ feerates });
    const fees = await a.chain.getFeeEstimates();
    expect(fees.rates).toEqual({ fastest: '20', halfHour: '20', hour: '8', economy: '1.5', minimum: '1.012' });
    expect(fees.node).toEqual({ opening: '8', mutualClose: '3', unilateralClose: '20' });
    expect(calls[0]?.params).toEqual({ style: 'perkb' });
    const bare = await adapter({ feerates: { perkb: { min_acceptable: 1000 } } }).adapter.chain.getFeeEstimates();
    expect(bare.rates.fastest).toBe('1');
    expect(bare.node).toEqual({});
  });

  it('is synced only when the node and its backend are at the same tip', async () => {
    const synced = (info: string, chain: unknown) =>
      adapter({ getinfo: info, getchaininfo: chain }).adapter.chain.isSynced();
    expect(await synced(getinfo(), { headercount: 126, blockcount: 126, ibd: false })).toBe(true);
    expect(await synced(getinfo(), { headercount: 127, blockcount: 126, ibd: false })).toBe(false);
    expect(await synced(getinfo(), { headercount: 126, blockcount: 126, ibd: true })).toBe(false);
    expect(await synced(getinfo(), { headercount: 127, blockcount: 127, ibd: false })).toBe(false);
    expect(await synced(getinfo({ warning_bitcoind_sync: 'behind' }), undefined)).toBe(false);
  });
});

describe('peers', () => {
  it('lists peers with cached aliases', async () => {
    const replies = {
      listpeers: {
        peers: [
          { id: PEER, connected: true, num_channels: 2, netaddr: ['127.0.0.1:19112'], features: '08' },
          { id: ID, connected: false },
        ],
      },
      listnodes: (p: Record<string, unknown>) => ({ nodes: p.id === PEER ? [{ nodeid: PEER, alias: 'bob' }] : [] }),
    };
    const { adapter: a, calls } = adapter(replies);
    const peers = await a.peer.listPeers();
    expect(peers).toEqual([
      { pubkey: PEER, alias: 'bob', connected: true, addresses: ['127.0.0.1:19112'], features: '08', numChannels: 2 },
      { pubkey: ID, connected: false, addresses: [], numChannels: 0 },
    ]);
    await a.peer.listPeers();
    expect(calls.filter((c) => c.command === 'listnodes')).toHaveLength(2);
  });

  it('connects with the parts of a node URI, refusing a malformed one before sending', async () => {
    const { adapter: a, calls } = adapter({ connect: { id: PEER, features: '', direction: 'out', address: {} } });
    expect(await a.peer.connect(`${PEER}@127.0.0.1:19112`)).toEqual({ pubkey: PEER });
    expect(calls[0]).toMatchObject({ rune: 'SPEND', params: { id: PEER, host: '127.0.0.1', port: 19112 } });
    await expect(a.peer.connect('nonsense@')).rejects.toMatchObject({ code: 'validation_failed', sent: false });
    await expect(adapter({ connect: new Error('bug') }).adapter.peer.connect(`${PEER}`)).rejects.toThrow('bug');
  });

  it('disconnects without force unless asked', async () => {
    const { adapter: a, calls } = adapter({ disconnect: {} });
    await a.peer.disconnect(parsePubkey(PEER));
    await a.peer.disconnect(parsePubkey(PEER), { force: true });
    expect(calls.map((c) => c.params)).toEqual([
      { id: PEER, force: false },
      { id: PEER, force: true },
    ]);
  });
});

describe('channels', () => {
  it('maps listpeerchannels, leaving out opens without a channel id', async () => {
    const { adapter: a } = adapter({
      listpeerchannels: {
        channels: [
          peerChannel(),
          peerChannel({ channel_id: undefined, state: 'OPENINGD' }),
          peerChannel({
            peer_connected: false,
            updates: undefined,
            close_to_addr: 'bcrt1qxyz',
            short_channel_id: undefined,
            opener: 'remote',
            private: true,
            channel_type: undefined,
            total_msat: 5n,
            to_us_msat: 9n,
          }),
        ],
      },
      listnodes: { nodes: [] },
    });
    const page = await a.channel.listChannels();
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: CHANNEL_ID,
      shortChannelId: '118x1x0',
      peer: { pubkey: PEER },
      state: { group: 'active', native: 'CHANNELD_NORMAL' },
      capacity: 2000000000n,
      local: 997780948n,
      remote: 1002219052n,
      fundingOutpoint: `${TXID}:0`,
      policy: { baseFeeMsat: 1n, feePpm: 10, cltvDelta: 6 },
      channelType: ['static_remotekey/even', 'anchors/even', 'unified_sigs/even'],
      stats: { inPayments: 16, outPayments: 57 },
    });
    expect(page.items[1]).toMatchObject({
      state: { group: 'inactive' },
      opener: 'remote',
      private: true,
      remote: 0n,
      closeTo: 'bcrt1qxyz',
      channelType: [],
    });
    expect(page.items[1]?.policy).toBeUndefined();
  });

  it('pages lists the node returns whole by offset', async () => {
    const channels = Array.from({ length: 3 }, (_, i) => peerChannel({ channel_id: `${i}`.repeat(64) }));
    const { adapter: a, calls } = adapter({ listpeerchannels: { channels }, listnodes: { nodes: [] } });
    const first = await a.channel.listChannels({ limit: 2 });
    expect(first.items.map((c) => c.id)).toEqual(['0'.repeat(64), '1'.repeat(64)]);
    const second = await a.channel.listChannels({ limit: 2, cursor: first.nextCursor ?? '' });
    expect(second).toEqual({ items: [expect.objectContaining({ id: '2'.repeat(64) })] });
    // A malformed page is refused before anything is sent, so `sent: false` is true.
    const sentBefore = calls.length;
    const refused = { code: 'validation_failed', sent: false };
    await expect(a.channel.listChannels({ cursor: 'i5' })).rejects.toMatchObject(refused);
    await expect(a.channel.listChannels({ limit: 0 })).rejects.toMatchObject(refused);
    await expect(a.channel.listClosedChannels({ limit: 0 })).rejects.toMatchObject(refused);
    await expect(a.onchain.listTransactions({ cursor: 'x' })).rejects.toMatchObject(refused);
    expect(calls.length).toBe(sentBefore);
  });

  it('maps closed channels with the native cause', async () => {
    const row = {
      channel_id: CHANNEL_ID,
      funding_txid: TXID,
      funding_outnum: 1,
      total_msat: 5000n,
      final_to_us_msat: 3000n,
      close_cause: 'remote',
    };
    const { adapter: a } = adapter({
      listclosedchannels: { closedchannels: [{ ...row, peer_id: PEER, short_channel_id: '1x2x3' }, row] },
      listnodes: { nodes: [{ nodeid: PEER, alias: 'bob' }] },
    });
    const page = await a.channel.listClosedChannels();
    expect(page.items[0]).toEqual({
      id: CHANNEL_ID,
      shortChannelId: '1x2x3',
      peer: { pubkey: PEER, alias: 'bob' },
      capacity: 5000n,
      finalLocal: 3000n,
      closeCause: 'remote',
      closeCauseRaw: 'remote',
      fundingOutpoint: `${TXID}:1`,
    });
    expect(page.items[1]?.peer).toBeUndefined();
  });

  it('pages HTLCs by the node index and tells current ones from the history', async () => {
    const htlc = (i: number, state: string) => ({
      short_channel_id: '118x1x0',
      created_index: i,
      expiry: 143,
      amount_msat: 1000n,
      direction: 'out',
      payment_hash: HASH,
      state,
    });
    const { adapter: a, calls } = adapter({
      listhtlcs: {
        htlcs: [htlc(4, 'SENT_ADD_ACK_REVOCATION'), htlc(3, 'RCVD_REMOVE_ACK_REVOCATION'), htlc(5, 'SENT_ADD_HTLC')],
      },
    });
    const page = await a.channel.listHtlcs({ limit: 2, cursor: 'i3' }, '118x1x0');
    expect(calls[0]?.params).toEqual({ id: '118x1x0', index: 'created', start: 3, limit: 3 });
    expect(page.items.map((h) => [h.state, h.inFlight])).toEqual([
      ['RCVD_REMOVE_ACK_REVOCATION', false],
      ['SENT_ADD_ACK_REVOCATION', true],
    ]);
    expect(page.nextCursor).toBe('i5');
  });

  it('opens a channel in whole satoshis with a short timeout; funding refusals are definitive', async () => {
    const { adapter: a, calls } = adapter(
      { fundchannel: { tx: '00', txid: TXID, outnum: 1, channel_id: CHANNEL_ID } },
      'SPEND',
      { channelTimeoutMs: 1234 },
    );
    expect(
      await a.channel.openChannel({
        peer: parsePubkey(PEER),
        amount: msat(200_000_000n),
        feeRate: '2',
        announce: false,
        pushMsat: msat(5n),
        minConf: 1,
      }),
    ).toEqual({ channelId: CHANNEL_ID, txid: TXID, outnum: 1 });
    expect(calls[0]).toMatchObject({
      rune: 'SPEND',
      timeoutMs: 1234,
      params: { id: PEER, amount: 200000n, feerate: '2000perkb', announce: false, push_msat: 5n, minconf: 1 },
    });
    await a.channel.openChannel({ peer: parsePubkey(PEER), amount: 'all' });
    expect(calls[1]?.params).toEqual({ id: PEER, amount: 'all' });
    for (const code of [300, 301, 313]) {
      const attempt = adapter({ fundchannel: nodeError(code) }).adapter.channel.openChannel({
        peer: parsePubkey(PEER),
        amount: 'all',
      });
      await expect(attempt).rejects.toMatchObject({ code: 'node_error', sent: true, definitive: true, nodeCode: code });
    }
    const unclear = adapter({ fundchannel: nodeError(-1) }).adapter.channel.openChannel({
      peer: parsePubkey(PEER),
      amount: 'all',
    });
    await expect(unclear).rejects.toMatchObject({ definitive: false });
    await expect(a.channel.openChannel({ peer: parsePubkey(PEER), amount: msat(1n) })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('closes cooperatively with unilateraltimeout 0 and by force with 1; a timeout means the close goes on', async () => {
    const { adapter: a, calls } = adapter({
      close: (p: Record<string, unknown>) =>
        p.id === 'slow'
          ? timeout()
          : p.id === 'new'
            ? { type: 'unopened' }
            : p.id === 'odd'
              ? { type: 'splice' }
              : { type: p.unilateraltimeout === 0 ? 'mutual' : 'unilateral', txids: [TXID] },
    });
    expect(await a.channel.closeChannel({ channel: parseTxid(CHANNEL_ID) as never, force: false })).toEqual({
      type: 'mutual',
      txids: [TXID],
    });
    expect(await a.channel.closeChannel({ channel: '1x1x0' as never, force: true, destination: 'bcrt1qxyz' })).toEqual({
      type: 'unilateral',
      txids: [TXID],
    });
    expect(calls.map((c) => c.params)).toEqual([
      { id: CHANNEL_ID, unilateraltimeout: 0 },
      { id: '1x1x0', unilateraltimeout: 1, destination: 'bcrt1qxyz' },
    ]);
    expect(await a.channel.closeChannel({ channel: 'slow' as never, force: false })).toEqual({ type: 'pending' });
    expect(await a.channel.closeChannel({ channel: 'new' as never, force: false })).toEqual({ type: 'unopened' });
    expect(await a.channel.closeChannel({ channel: 'odd' as never, force: false })).toEqual({ type: 'pending' });
    await expect(
      adapter({ close: nodeError(-1) }).adapter.channel.closeChannel({ channel: 'x' as never, force: false }),
    ).rejects.toMatchObject({ nodeCode: -1 });
  });

  it('sets only the policy fields given', async () => {
    const { adapter: a, calls } = adapter({ setchannel: { channels: [] } });
    await a.channel.setPolicy({ channel: 'all', feePpm: 5 });
    await a.channel.setPolicy({
      channel: '1x1x0' as never,
      baseFeeMsat: msat(1000n),
      minHtlcMsat: msat(1n),
      maxHtlcMsat: msat(9n),
    });
    expect(calls.map((c) => c.params)).toEqual([
      { id: 'all', feeppm: 5 },
      { id: '1x1x0', feebase: 1000n, htlcmin: 1n, htlcmax: 9n },
    ]);
  });
});

describe('receive', () => {
  const invoiceRow = (i: number, extra: Record<string, unknown> = {}) => ({
    label: `l${i}`,
    description: 'coffee',
    payment_hash: i.toString(16).padStart(64, '0'),
    status: 'unpaid',
    expires_at: 1800000000,
    amount_msat: 1000n,
    bolt11: 'lnbcrt1',
    created_index: i,
    ...extra,
  });

  it('creates an any-amount invoice and passes the private-channel option only when set', async () => {
    const reply = { bolt11: 'lnbcrt1', payment_hash: HASH, expires_at: 1800000000 };
    const { adapter: a, calls } = adapter({ invoice: reply });
    const invoice = await a.receive.createInvoice({ description: 'any', label: 'l', exposePrivateChannels: true });
    expect(invoice.amount).toBeUndefined();
    expect(calls[0]?.params).toEqual({
      amount_msat: 'any',
      label: 'l',
      description: 'any',
      exposeprivatechannels: true,
    });
  });

  it('lists invoices by created index and maps paid ones with their preimage', async () => {
    const paid = invoiceRow(2, {
      status: 'paid',
      amount_received_msat: 1000n,
      paid_at: 1700000000,
      payment_preimage: PREIMAGE,
    });
    const { adapter: a, calls } = adapter({
      listinvoices: {
        invoices: [paid, invoiceRow(1, { amount_msat: undefined, description: undefined, bolt11: undefined })],
      },
    });
    const page = await a.receive.listInvoices({ limit: 1 });
    expect(calls[0]?.params).toEqual({ index: 'created', start: 0, limit: 2 });
    expect(page.items[0]).toMatchObject({ label: 'l1', description: '', bolt11: '', status: 'unpaid' });
    expect(page.items[0]?.amount).toBeUndefined();
    expect(page.nextCursor).toBe('i2');
    const second = await a.receive.listInvoices({ cursor: 'i2' });
    expect(second.items.find((i) => i.status === 'paid')).toMatchObject({
      amountReceived: 1000n,
      preimage: PREIMAGE,
      paidAt: new Date(1700000000000).toISOString(),
    });
    const bad = adapter({ listinvoices: { invoices: [invoiceRow(1, { status: 'refunded' })] } });
    await expect(bad.adapter.receive.listInvoices()).rejects.toMatchObject({ code: 'node_bad_response' });
  });

  it('finds one invoice by payment hash', async () => {
    const row = invoiceRow(7);
    const { adapter: a, calls } = adapter({ listinvoices: { invoices: [row] } });
    expect((await a.receive.getInvoice(parsePaymentHash(row.payment_hash)))?.label).toBe('l7');
    expect(calls[0]?.params).toEqual({ payment_hash: row.payment_hash });
    expect(await a.receive.getInvoice(parsePaymentHash(HASH))).toBeUndefined();
  });

  it('asks for a bech32 or taproot address', async () => {
    const { adapter: a, calls } = adapter({
      newaddr: (p: Record<string, unknown>) => (p.addresstype === 'p2tr' ? { p2tr: 'bcrt1p' } : { bech32: 'bcrt1q' }),
    });
    expect((await a.receive.newAddress('p2wpkh')).address).toBe('bcrt1q');
    expect((await a.receive.newAddress('p2tr')).address).toBe('bcrt1p');
    expect(calls.map((c) => c.params.addresstype)).toEqual(['bech32', 'p2tr']);
    await expect(adapter({ newaddr: {} }).adapter.receive.newAddress('p2tr')).rejects.toMatchObject({
      code: 'node_bad_response',
    });
  });

  it('creates, lists and disables offers', async () => {
    const row = {
      offer_id: HASH,
      active: true,
      single_use: false,
      bolt12: 'lno1x',
      used: false,
      description: 'tea',
      label: 'o',
    };
    const { adapter: a, calls } = adapter({
      offer: { ...row, created: true },
      listoffers: { offers: [row] },
      disableoffer: { ...row, active: false },
    });
    expect(
      await a.receive.createOffer({ amount: msat(5000n), description: 'tea', label: 'o', singleUse: true }),
    ).toMatchObject({ id: HASH, amount: 5000n, active: true });
    expect(calls[0]?.params).toEqual({ amount: '5000msat', description: 'tea', label: 'o', single_use: true });
    await a.receive.createOffer({ description: 'tea' });
    expect(calls[1]?.params).toEqual({ amount: 'any', description: 'tea' });
    expect(await a.receive.listOffers()).toEqual([
      { id: HASH, bolt12: 'lno1x', description: 'tea', label: 'o', active: true, singleUse: false, used: false },
    ]);
    expect((await a.receive.disableOffer(HASH)).active).toBe(false);
    await expect(a.receive.disableOffer('nope')).rejects.toMatchObject({ code: 'validation_failed' });
    expect(calls).toHaveLength(4);
  });
});

describe('pay', () => {
  it('maps the node decode of invoices and offers', async () => {
    const replies = {
      decode: (p: Record<string, unknown>) =>
        p.string === 'lno1'
          ? {
              type: 'bolt12 offer',
              valid: true,
              offer_amount_msat: 5000n,
              offer_issuer_id: PEER,
              offer_description: 'tea',
            }
          : {
              type: 'bolt11 invoice',
              valid: true,
              amount_msat: 1000n,
              payee: PEER,
              payment_hash: HASH,
              description: 'x',
            },
    };
    const { adapter: a } = adapter(replies);
    expect(await a.pay.decode('lnbcrt1')).toEqual({
      type: 'bolt11 invoice',
      valid: true,
      amount: 1000n,
      payee: PEER,
      paymentHash: HASH,
      description: 'x',
    });
    expect(await a.pay.decode('lno1')).toEqual({
      type: 'bolt12 offer',
      valid: true,
      amount: 5000n,
      payee: PEER,
      description: 'tea',
    });
    expect(await adapter({ decode: { type: 'rune', valid: false } }).adapter.pay.decode('x')).toEqual({
      type: 'rune',
      valid: false,
    });
  });

  it('previews a route with getroutes from our own node, fee from the first hops', async () => {
    const getroutes = {
      probability_ppm: 900000,
      routes: [
        { amount_msat: 6000n, path: [{ amount_msat: 6010n }, { amount_msat: 6000n }] },
        { amount_msat: 4000n, path: [{ amount_msat: 4005n }] },
      ],
    };
    const { adapter: a, calls } = adapter({ getinfo: getinfo(), getroutes });
    const request = { destination: parsePubkey(PEER), amount: msat(10_000n), maxFee: msat(100n), finalCltv: 18 };
    expect(await a.pay.previewRoute(request)).toEqual({ fee: 15n, hops: 2, probabilityPpm: 900000 });
    await a.pay.previewRoute(request);
    expect(calls.filter((c) => c.command === 'getinfo')).toHaveLength(1);
    expect(calls[1]?.params).toEqual({
      source: ID,
      destination: PEER,
      amount_msat: 10_000n,
      layers: ['auto.localchans', 'auto.sourcefree'],
      maxfee_msat: 100n,
      final_cltv: 18,
    });
    expect(
      await adapter({ getinfo: getinfo(), getroutes: nodeError(205) }).adapter.pay.previewRoute(request),
    ).toBeUndefined();
    expect(
      await adapter({ getinfo: getinfo(), getroutes: { probability_ppm: 0, routes: [] } }).adapter.pay.previewRoute(
        request,
      ),
    ).toBeUndefined();
    await expect(
      adapter({ getinfo: getinfo(), getroutes: timeout() }).adapter.pay.previewRoute(request),
    ).rejects.toMatchObject({ code: 'node_unreachable' });
  });

  it('fetches an offer invoice, with an amount when given', async () => {
    const { adapter: a, calls } = adapter({ fetchinvoice: { invoice: 'lni1x', changes: {} } });
    expect(await a.pay.fetchOfferInvoice('lno1', msat(5n))).toBe('lni1x');
    await a.pay.fetchOfferInvoice('lno1');
    expect(calls.map((c) => c.params)).toEqual([{ offer: 'lno1', amount_msat: 5n }, { offer: 'lno1' }]);
  });

  it('lists payments by created index, one row per payment', async () => {
    const pay = (i: number, extra: Record<string, unknown> = {}) => ({
      payment_hash: HASH,
      status: 'complete',
      created_at: 1700000000 + i,
      created_index: i,
      amount_msat: 1000n,
      amount_sent_msat: 1002n,
      preimage: PREIMAGE,
      destination: PEER,
      completed_at: 1700000100,
      label: 'x',
      number_of_parts: 2,
      ...extra,
    });
    const { adapter: a } = adapter({
      listpays: {
        pays: [
          pay(1),
          pay(2, {
            status: 'pending',
            amount_msat: undefined,
            amount_sent_msat: undefined,
            preimage: undefined,
            destination: undefined,
            completed_at: undefined,
            label: undefined,
            number_of_parts: undefined,
          }),
        ],
      },
    });
    const page = await a.pay.listPayments({ limit: 5 });
    expect(page.items[0]).toEqual({
      paymentHash: HASH,
      status: 'succeeded',
      destination: PEER,
      amount: 1000n,
      amountSent: 1002n,
      fee: 2n,
      createdAt: new Date(1700000001000).toISOString(),
      completedAt: new Date(1700000100000).toISOString(),
      preimage: PREIMAGE,
      label: 'x',
      parts: 2,
    });
    expect(page.items[1]).toEqual({
      paymentHash: HASH,
      status: 'pending',
      createdAt: new Date(1700000002000).toISOString(),
    });
    await expect(
      adapter({ listpays: { pays: [pay(1, { status: 'odd' })] } }).adapter.pay.listPayments(),
    ).rejects.toMatchObject({ code: 'node_bad_response' });
  });

  it('finds payments by label, scanning listsendpays page by page', async () => {
    const part = (i: number, label: string, hash = HASH) => ({
      payment_hash: hash,
      status: 'complete',
      created_index: i,
      label,
      amount_sent_msat: 10n,
    });
    const first = Array.from({ length: 1000 }, (_, i) => part(i + 1, i === 5 ? 'mine' : 'other'));
    const { adapter: a, calls } = adapter({
      listsendpays: (p: Record<string, unknown>) => ({
        payments: p.start === 0 ? first : [part(1001, 'mine'), part(1002, 'mine', '11'.repeat(32))],
      }),
    });
    const found = await a.pay.listByLabel('mine');
    expect(found.map((p) => [p.paymentHash, p.parts])).toEqual([
      [HASH, 2],
      ['11'.repeat(32), 1],
    ]);
    expect(calls.map((c) => c.params.start)).toEqual([0, 1001]);
  });

  it('pays an invoice without an amount with the amount given', async () => {
    const { adapter: a, calls } = adapter({
      xpay: { payment_preimage: PREIMAGE, amount_msat: 500n, amount_sent_msat: 500n },
    });
    await a.pay.pay({ bolt11: 'lnbcrt1', amount: msat(500n), maxFee: msat(5n), label: 'l', retryForSeconds: 10 });
    expect(calls[0]).toMatchObject({ params: { invstring: 'lnbcrt1', amount_msat: 500n }, timeoutMs: 40_000 });
  });

  describe('already paid (219)', () => {
    const request = (bolt11: string) => ({ bolt11, maxFee: msat(5n), label: 'l', retryForSeconds: 10 });
    // A real regtest invoice (committed fixture); the recorded listsendpays rows carry its hash.
    const invoice = fixtures.invoices[0]?.bolt11 ?? '';
    const hash = fixtures.invoices[0]?.paymentHash ?? '';

    it('returns the earlier success from the node records', async () => {
      const { adapter: a } = adapter({
        xpay: nodeError(219),
        listsendpays: {
          payments: [
            {
              payment_hash: hash,
              status: 'complete',
              amount_msat: 1000n,
              amount_sent_msat: 1001n,
              payment_preimage: PREIMAGE,
            },
          ],
        },
      });
      expect(await a.pay.pay(request(invoice))).toEqual({
        paymentHash: hash,
        preimage: PREIMAGE,
        amount: 1000n,
        amountSent: 1001n,
        fee: 1n,
      });
    });

    it('stays unclear when the records do not show a success', async () => {
      for (const listsendpays of [{ payments: [] }, new Error('reset')]) {
        const attempt = adapter({ xpay: nodeError(219), listsendpays }).adapter.pay.pay(request(invoice));
        await expect(attempt).rejects.toMatchObject({ nodeCode: 219, definitive: false });
      }
      const noAmount = adapter({
        xpay: nodeError(219),
        listsendpays: {
          payments: [{ payment_hash: hash, status: 'complete', amount_sent_msat: 7n, payment_preimage: PREIMAGE }],
        },
      });
      expect((await noAmount.adapter.pay.pay(request(invoice))).amount).toBe(7n);
    });
  });

  describe('keysend', () => {
    const request = {
      destination: parsePubkey(PEER),
      amount: msat(3000n),
      maxFee: msat(10n),
      label: 'intent-k',
      retryForSeconds: 20,
    };

    it('sends xkeysend with our label and the spend rune', async () => {
      const { adapter: a, calls } = adapter({
        xkeysend: {
          payment_preimage: PREIMAGE,
          amount_msat: 3000n,
          amount_sent_msat: 3001n,
          failed_parts: 0,
          successful_parts: 1,
        },
      });
      expect(await a.pay.keysend(request)).toMatchObject({ paymentHash: PREIMAGE_HASH, fee: 1n });
      expect(calls[0]).toMatchObject({
        rune: 'SPEND',
        params: { destination: PEER, amount_msat: 3000n, maxfee: 10n, retry_for: 20, label: 'intent-k' },
      });
    });

    it('is definitively failed only when nothing under its label went out', async () => {
      const none = adapter({ xkeysend: nodeError(205), listsendpays: { payments: [] } });
      await expect(none.adapter.pay.keysend(request)).rejects.toMatchObject({
        code: 'payment_failed',
        definitive: true,
      });
      const failed = adapter({
        xkeysend: nodeError(205),
        listsendpays: { payments: [{ payment_hash: HASH, status: 'failed', label: 'intent-k', created_index: 1 }] },
      });
      await expect(failed.adapter.pay.keysend(request)).rejects.toMatchObject({ code: 'payment_failed' });
      const pending = adapter({
        xkeysend: nodeError(205),
        listsendpays: { payments: [{ payment_hash: HASH, status: 'pending', label: 'intent-k', created_index: 1 }] },
      });
      await expect(pending.adapter.pay.keysend(request)).rejects.toMatchObject({
        code: 'node_error',
        definitive: false,
      });
    });
  });
});

describe('on-chain', () => {
  it('asks listaddresses whether an address belongs to the wallet', async () => {
    const issued = { addresses: [{ keyidx: 3, bech32: 'bcrt1qown', p2tr: 'bcrt1pown' }] };
    const { adapter: a, calls } = adapter({ listaddresses: issued });
    expect(await a.onchain.ownsAddress('bcrt1qown')).toBe(true);
    expect(calls.at(-1)).toMatchObject({ command: 'listaddresses', rune: 'VIEW', params: { address: 'bcrt1qown' } });
    const { adapter: b } = adapter({ listaddresses: { addresses: [] } });
    expect(await b.onchain.ownsAddress('bcrt1qelsewhere')).toBe(false);
  });

  it('lists coins with their status and reservation', async () => {
    const { adapter: a } = adapter({
      listfunds: {
        outputs: [
          {
            txid: TXID,
            output: 0,
            amount_msat: 1000n,
            status: 'confirmed',
            reserved: true,
            blockheight: 100,
            address: 'bcrt1q',
          },
          { txid: TXID, output: 1, amount_msat: 5n, status: 'frozen' },
        ],
        channels: [],
      },
    });
    expect(await a.onchain.listUtxos()).toEqual([
      {
        outpoint: `${TXID}:0`,
        amount: 1000n,
        address: 'bcrt1q',
        status: 'confirmed',
        reserved: true,
        blockHeight: 100,
      },
      { outpoint: `${TXID}:1`, amount: 5n, status: 'unknown', reserved: false },
    ]);
  });

  it('prepares in whole satoshis, sends, discards and unreserves with the spend rune', async () => {
    const { adapter: a, calls } = adapter({
      txprepare: { psbt: 'cHNidP8=', unsigned_tx: '00', txid: TXID },
      txsend: { psbt: 'x', tx: '00', txid: TXID },
      txdiscard: { unsigned_tx: '00', txid: TXID },
      unreserveinputs: { reservations: [] },
    });
    expect(
      await a.onchain.prepare({
        outputs: [{ address: 'bcrt1q', amount: msat(10_000_000n) }],
        feeRate: '1.5',
        minConf: 1,
        utxos: [`${TXID}:0`],
      }),
    ).toEqual({ txid: TXID, psbt: 'cHNidP8=' });
    await a.onchain.prepare({ outputs: [{ address: 'bcrt1q', amount: 'all' }] });
    expect(await a.onchain.send(parseTxid(TXID))).toEqual({ txid: TXID });
    await a.onchain.discard(parseTxid(TXID));
    await a.onchain.unreserve('cHNidP8=');
    expect(calls.map((c) => [c.command, c.rune, c.params])).toEqual([
      [
        'txprepare',
        'SPEND',
        { outputs: [{ bcrt1q: '10000sat' }], feerate: '1500perkb', minconf: 1, utxos: [`${TXID}:0`] },
      ],
      ['txprepare', 'SPEND', { outputs: [{ bcrt1q: 'all' }] }],
      ['txsend', 'SPEND', { txid: TXID }],
      ['txdiscard', 'SPEND', { txid: TXID }],
      ['unreserveinputs', 'SPEND', { psbt: 'cHNidP8=' }],
    ]);
  });

  it('refuses malformed on-chain requests before sending, and marks unaffordable ones definitive', async () => {
    const { adapter: a, calls } = adapter({ txprepare: nodeError(301) });
    await expect(a.onchain.prepare({ outputs: [] })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      a.onchain.prepare({
        outputs: [
          { address: 'a', amount: 'all' },
          { address: 'b', amount: msat(1000n) },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(a.onchain.prepare({ outputs: [{ address: 'a', amount: msat(1n) }] })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(0);
    await expect(a.onchain.prepare({ outputs: [{ address: 'a', amount: 'all' }] })).rejects.toMatchObject({
      nodeCode: 301,
      definitive: true,
    });
    const sendError = adapter({ txsend: nodeError(-1) });
    await expect(sendError.adapter.onchain.send(parseTxid(TXID))).rejects.toMatchObject({ definitive: false });
  });
});

describe('routing and plugins', () => {
  it('maps forwards, keeping an unknown status raw', async () => {
    const row = {
      created_index: 1,
      in_channel: '120x1x0',
      in_msat: 7000071n,
      status: 'settled',
      received_time: 1791865658.523,
      out_channel: '118x1x0',
      out_msat: 7000000n,
      fee_msat: 71n,
      resolved_time: 1791865658.859,
    };
    const { adapter: a } = adapter({
      listforwards: {
        forwards: [
          row,
          { created_index: 2, in_channel: '1x1x1', in_msat: 5n, status: 'mystery', received_time: 1, failcode: 4103 },
        ],
      },
    });
    const page = await a.routing.listForwards();
    expect(page.items[0]).toEqual({
      inChannel: '120x1x0',
      outChannel: '118x1x0',
      amountIn: 7000071n,
      amountOut: 7000000n,
      fee: 71n,
      status: 'settled',
      statusRaw: 'settled',
      receivedAt: '2026-10-13T04:27:38.523Z',
      resolvedAt: '2026-10-13T04:27:38.859Z',
    });
    expect(page.items[1]).toMatchObject({ status: 'unknown', statusRaw: 'mystery', failCode: 4103 });
  });

  it('lists plugins by file name', async () => {
    const { adapter: a, calls } = adapter({
      plugin: {
        command: 'list',
        plugins: [
          { name: '/usr/libexec/c-lightning/plugins/bookkeeper', active: true },
          { name: 'x', active: false },
        ],
      },
    });
    expect(await a.plugin.listPlugins()).toEqual([
      { name: 'bookkeeper', active: true },
      { name: 'x', active: false },
    ]);
    expect(calls[0]?.params).toEqual({ subcommand: 'list' });
  });
});
