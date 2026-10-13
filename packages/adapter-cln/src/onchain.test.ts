// On-chain history from listtransactions and the bookkeeper's account events (shapes from the regtest nodes).
import { describe, expect, it } from 'vitest';
import { adapter, getinfo, nodeError } from './fixtures/recorded.ts';

const tx = (n: number) => n.toString(16).padStart(64, '0');
const OPEN = tx(1);
const DEPOSIT = tx(2);
const SEND = tx(3);
const CLOSE = tx(4);
const UNCONFIRMED = tx(5);
const FOREIGN = tx(6);

const transactions = {
  transactions: [
    { hash: DEPOSIT, blockheight: 100 },
    { hash: OPEN, blockheight: 110 },
    { hash: SEND, blockheight: 120 },
    { hash: UNCONFIRMED, blockheight: 0 },
  ],
};
const events = {
  events: [
    {
      account: 'wallet',
      type: 'chain',
      tag: 'deposit',
      credit_msat: 500000000n,
      debit_msat: 0n,
      timestamp: 1,
      outpoint: `${DEPOSIT}:0`,
      blockheight: 100,
    },
    // A channel open: the deposit is spent, change comes back, the channel account gets its funding output.
    {
      account: 'wallet',
      type: 'chain',
      tag: 'withdrawal',
      credit_msat: 0n,
      debit_msat: 500000000n,
      timestamp: 2,
      outpoint: `${DEPOSIT}:0`,
      txid: OPEN,
      blockheight: 110,
    },
    {
      account: 'wallet',
      type: 'chain',
      tag: 'deposit',
      credit_msat: 299000000n,
      debit_msat: 0n,
      timestamp: 2,
      outpoint: `${OPEN}:1`,
      blockheight: 110,
    },
    {
      account: 'wallet',
      type: 'onchain_fee',
      tag: 'onchain_fee',
      credit_msat: 1000000n,
      debit_msat: 0n,
      timestamp: 2,
      txid: OPEN,
    },
    {
      account: 'chan1',
      type: 'chain',
      tag: 'channel_open',
      credit_msat: 200000000n,
      debit_msat: 0n,
      timestamp: 2,
      outpoint: `${OPEN}:0`,
      blockheight: 110,
    },
    // A send: the change is spent, a smaller change comes back.
    {
      account: 'wallet',
      type: 'chain',
      tag: 'withdrawal',
      credit_msat: 0n,
      debit_msat: 299000000n,
      timestamp: 3,
      outpoint: `${OPEN}:1`,
      txid: SEND,
      blockheight: 120,
    },
    {
      account: 'wallet',
      type: 'chain',
      tag: 'deposit',
      credit_msat: 198000000n,
      debit_msat: 0n,
      timestamp: 3,
      outpoint: `${SEND}:1`,
      blockheight: 120,
    },
    {
      account: 'wallet',
      type: 'onchain_fee',
      tag: 'onchain_fee',
      credit_msat: 1500000n,
      debit_msat: 500000n,
      timestamp: 3,
      txid: SEND,
    },
    // A close the wallet has no row for yet in listtransactions; and a peer transaction the wallet never touched.
    {
      account: 'chan1',
      type: 'chain',
      tag: 'channel_close',
      credit_msat: 0n,
      debit_msat: 200000000n,
      timestamp: 4,
      outpoint: `${OPEN}:0`,
      txid: CLOSE,
    },
    {
      account: 'wallet',
      type: 'chain',
      tag: 'deposit',
      credit_msat: 199000000n,
      debit_msat: 0n,
      timestamp: 4,
      outpoint: `${CLOSE}:0`,
    },
    {
      account: 'external',
      type: 'chain',
      tag: 'to_them',
      credit_msat: 5n,
      debit_msat: 0n,
      timestamp: 4,
      outpoint: `${FOREIGN}:0`,
    },
    { account: 'chan1', type: 'channel', tag: 'invoice', credit_msat: 1000n, debit_msat: 0n, timestamp: 5 },
  ],
};

describe('on-chain history', () => {
  it('builds amounts, fees and kinds from the bookkeeper, newest first', async () => {
    const { adapter: a } = adapter({
      getinfo: getinfo({ blockheight: 125 }),
      listtransactions: transactions,
      'bkpr-listaccountevents': events,
    });
    const page = await a.onchain.listTransactions();
    expect(
      page.items.map((t) => [t.txid, t.kind, t.amount?.direction, t.amount?.value, t.fee, t.confirmations]),
    ).toEqual([
      [CLOSE, 'channel-close', 'in', 199000000n, undefined, 0],
      [UNCONFIRMED, 'other', undefined, undefined, undefined, 0],
      [SEND, 'send', 'out', 101000000n, 1000000n, 6],
      [OPEN, 'channel-open', 'out', 201000000n, 1000000n, 16],
      [DEPOSIT, 'receive', 'in', 500000000n, undefined, 26],
    ]);
    expect(page.items.find((t) => t.txid === SEND)?.blockHeight).toBe(120);
  });

  it('falls back to the raw list without amounts when the bookkeeper is not running', async () => {
    const { adapter: a } = adapter({
      getinfo: getinfo({ blockheight: 125 }),
      listtransactions: transactions,
      'bkpr-listaccountevents': nodeError(-32601, 'Unknown command'),
    });
    const page = await a.onchain.listTransactions({ limit: 2 });
    expect(page.items).toEqual([
      { txid: UNCONFIRMED, confirmations: 0, kind: 'other' },
      { txid: SEND, blockHeight: 120, confirmations: 6, kind: 'other' },
    ]);
    expect(page.nextCursor).toBe('o2');
  });

  it('passes other bookkeeper errors on', async () => {
    const attempt = adapter({
      getinfo: getinfo(),
      listtransactions: transactions,
      'bkpr-listaccountevents': nodeError(-1),
    }).adapter.onchain.listTransactions();
    await expect(attempt).rejects.toMatchObject({ nodeCode: -1 });
  });
});
