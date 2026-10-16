import { describe, expect, it } from 'vitest';
import {
  ChannelParam,
  InvoiceRecordResponse,
  NewAddressRequest,
  NewAddressResponse,
  PageQuery,
  PaymentRecordResponse,
} from './index.ts';

const node = 'b2c913e0-8913-4ab8-8d60-de4fb9fb2216';
const hash = 'ab'.repeat(32);

describe('read API contract', () => {
  it('bounds the page query and coerces the limit from the query string', () => {
    expect(PageQuery.parse({ limit: '25', cursor: 'o50' })).toEqual({ limit: 25, cursor: 'o50' });
    expect(PageQuery.parse({})).toEqual({});
    for (const bad of [{ limit: '0' }, { limit: '201' }, { limit: '1.5' }, { cursor: '' }, { cursor: 'x'.repeat(201) }])
      expect(PageQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(PageQuery.safeParse({ sort: 'desc' }).success).toBe(false);
  });

  it('names a channel by short channel id, channel id or funding outpoint only', () => {
    for (const channel of ['103x1x0', 'cd'.repeat(32), `${'ef'.repeat(32)}:1`])
      expect(ChannelParam.safeParse({ nodeId: node, channel }).success, channel).toBe(true);
    for (const channel of ['closed', '103x1', 'CD'.repeat(32), `${'ef'.repeat(32)}:`])
      expect(ChannelParam.safeParse({ nodeId: node, channel }).success, channel).toBe(false);
  });

  it('never carries a preimage in history records', () => {
    const invoice = {
      paymentHash: hash,
      bolt11: 'lnbcrt1',
      description: '',
      label: 'l',
      status: 'paid',
      expiresAt: '2026-10-16T10:00:00.000Z',
    };
    expect(InvoiceRecordResponse.safeParse(invoice).success).toBe(true);
    expect(InvoiceRecordResponse.safeParse({ ...invoice, preimage: hash }).success).toBe(false);
    expect(PaymentRecordResponse.safeParse({ paymentHash: hash, status: 'succeeded', preimage: hash }).success).toBe(
      false,
    );
  });

  it('defaults new addresses to P2WPKH and names the chain in the reply', () => {
    expect(NewAddressRequest.parse({})).toEqual({ type: 'p2wpkh' });
    expect(NewAddressRequest.safeParse({ type: 'p2pkh' }).success).toBe(false);
    const reply = { address: 'bcrt1q', type: 'p2tr', network: 'regtest', createdAt: '2026-10-16T10:00:00.000Z' };
    expect(NewAddressResponse.safeParse(reply).success).toBe(false);
    expect(NewAddressResponse.safeParse({ ...reply, chain: 'blake2b' }).success).toBe(true);
  });
});
