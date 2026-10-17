import { describe, expect, it } from 'vitest';
import {
  explorerTxUrl,
  filterTransactions,
  OnchainSearch,
  presetRate,
  readTransactions,
  sendSearch,
  transactionsCsv,
  utxosOf,
  type OnchainTx,
  type Utxo,
} from './data.ts';

const id = (n: number) => n.toString(16).padStart(64, '0');
const tx = (n: number, fields: Partial<OnchainTx> = {}): OnchainTx => ({
  txid: id(n),
  confirmations: n,
  kind: 'receive',
  ...fields,
});

describe('on-chain search params', () => {
  it('falls back to defaults for invalid values and coerces the router’s numbers', () => {
    expect(OnchainSearch.parse({})).toEqual({ kind: 'all', sort: '-height', more: 0 });
    expect(OnchainSearch.parse({ kind: 'bogus', sort: 'x', more: 99 })).toEqual({
      kind: 'all',
      sort: '-height',
      more: 0,
    });
    expect(OnchainSearch.parse({ kind: 'send', sort: 'amount', more: 3 })).toEqual({
      kind: 'send',
      sort: 'amount',
      more: 3,
    });
  });

  it('prefills the send form only with an address and a whole number of sats', () => {
    expect(sendSearch({})).toEqual({});
    expect(sendSearch({ address: ' bcrt1qabc ', amount: 1000 })).toEqual({ address: 'bcrt1qabc', amount: '1000' });
    expect(sendSearch({ address: 'a'.repeat(201), amount: '1.5' })).toEqual({});
    expect(sendSearch({ address: { x: 1 }, amount: '-3' })).toEqual({});
  });
});

describe('readTransactions', () => {
  it('reads from the top, drops rows repeated after a shift, and stops at the bound', async () => {
    const pages: Record<string, { items: OnchainTx[]; nextCursor?: string }> = {
      first: { items: [tx(1), tx(2)], nextCursor: 'o2' },
      // A new transaction arrived between the reads: row 2 comes again.
      o2: { items: [tx(2), tx(3)], nextCursor: 'o4' },
      o4: { items: [tx(4), tx(5)] },
    };
    const seen: (string | undefined)[] = [];
    const read = async (cursor?: string) => {
      seen.push(cursor);
      return pages[cursor ?? 'first'] as { items: OnchainTx[]; nextCursor?: string };
    };
    expect((await readTransactions(read, 10)).items.map((t) => t.confirmations)).toEqual([1, 2, 3, 4, 5]);
    const bounded = await readTransactions(read, 3);
    expect(bounded.items.map((t) => t.confirmations)).toEqual([1, 2, 3]);
    expect(bounded.more).toBe(true);
    const found = await readTransactions(read, 10, (t) => t.confirmations === 2);
    expect(found.items.at(-1)?.confirmations).toBe(2);
    expect(seen.at(-1)).toBeUndefined();
  });

  it('refuses a cursor that repeats', async () => {
    const read = async () => ({ items: [tx(1)], nextCursor: 'o1' });
    await expect(readTransactions(read, 10)).rejects.toThrow('Repeated transaction cursor');
  });
});

describe('filterTransactions', () => {
  const rows = [
    tx(1, { kind: 'send', amount: { direction: 'out', value: '5000' } }),
    tx(2, { amount: { direction: 'in', value: '1000' } }),
    tx(3, { kind: 'channel-open' }),
  ];
  it('keeps node order newest first, reverses it, filters by kind and sorts signed amounts in bigint', () => {
    const order = (list: OnchainTx[]) => list.map((t) => t.confirmations);
    expect(order(filterTransactions(rows, 'all', '-height'))).toEqual([1, 2, 3]);
    expect(order(filterTransactions(rows, 'all', 'height'))).toEqual([3, 2, 1]);
    expect(order(filterTransactions(rows, 'send', '-height'))).toEqual([1]);
    expect(order(filterTransactions(rows, 'all', '-amount'))).toEqual([2, 3, 1]);
    expect(order(filterTransactions(rows, 'all', 'amount'))).toEqual([1, 3, 2]);
  });
});

describe('presetRate', () => {
  it('rounds the node estimate up to three decimals, and refuses unusable values', () => {
    expect(presetRate('12')).toBe('12');
    expect(presetRate('1.012')).toBe('1.012');
    expect(presetRate('1.0121')).toBe('1.013');
    expect(presetRate('2.5000')).toBe('2.5');
    expect(presetRate('0')).toBeUndefined();
    expect(presetRate('0.0001')).toBe('0.001');
    expect(presetRate('abc')).toBeUndefined();
    expect(presetRate(undefined)).toBeUndefined();
  });
});

describe('explorerTxUrl', () => {
  it('links only mainnet transactions, to the chain profile’s default explorer', () => {
    expect(explorerTxUrl('blake2b', 'mainnet', id(1))).toBe(`https://mempool.kilombino.com/tx/${id(1)}`);
    expect(explorerTxUrl('bitcoin', 'mainnet', id(1))).toBe(`https://mempool.space/tx/${id(1)}`);
    expect(explorerTxUrl('blake2b', 'regtest', id(1))).toBeUndefined();
    expect(explorerTxUrl('bitcoin', 'mainnet', 'x')).toBeUndefined();
  });
});

describe('transactionsCsv', () => {
  it('writes msat precision, empty cells for missing values and neutralises formula-like labels', () => {
    const csv = transactionsCsv([
      tx(1, {
        kind: 'send',
        amount: { direction: 'out', value: '1234567' },
        fee: '141000',
        blockHeight: 100,
        label: '=HYPERLINK("x")',
      }),
      tx(2, { confirmations: 0, label: 'plain, with comma' }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('txid,kind,direction,amount_sat,fee_sat,block_height,confirmations,label');
    expect(lines[1]).toBe(`${id(1)},send,out,1234.567,141,100,1,"'=HYPERLINK(""x"")"`);
    expect(lines[2]).toBe(`${id(2)},receive,,,,,0,"plain, with comma"`);
    expect(lines[3]).toBe('');
  });
});

describe('utxosOf', () => {
  it('finds the wallet coins a transaction created', () => {
    const coin = (outpoint: string): Utxo =>
      ({ outpoint, amount: '1000', status: 'confirmed', reserved: false }) as Utxo;
    expect(utxosOf([coin(`${id(1)}:0`), coin(`${id(2)}:1`), coin(`${id(1)}:3`)], id(1))).toHaveLength(2);
  });
});
