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
      listtransactions: {
        transactions: transactions.transactions.map((t) =>
          t.hash === UNCONFIRMED
            ? { ...t, inputs: [{ txid: FOREIGN, index: 7 }], outputs: [{ index: 0, amount_msat: 1n }] }
            : t,
        ),
      },
      'bkpr-listaccountevents': events,
      // Asked only for the transaction the bookkeeper has not booked yet (unconfirmed).
      listfunds: { outputs: [{ txid: FOREIGN, output: 7, amount_msat: 7000n, status: 'spent' }] },
    });
    const page = await a.onchain.listTransactions();
    expect(
      page.items.map((t) => [t.txid, t.kind, t.amount?.direction, t.amount?.value, t.fee, t.confirmations]),
    ).toEqual([
      [CLOSE, 'channel-close', 'in', 199000000n, undefined, 0],
      [UNCONFIRMED, 'send', 'out', 7000n, 6999n, 0],
      [SEND, 'send', 'out', 101000000n, 1000000n, 6],
      [OPEN, 'channel-open', 'out', 201000000n, 1000000n, 16],
      [DEPOSIT, 'receive', 'in', 500000000n, undefined, 26],
    ]);
    expect(page.items.find((t) => t.txid === SEND)?.blockHeight).toBe(120);
  });

  it("works the amounts out from the wallet's own coins when the bookkeeper is not running", async () => {
    const coin = (txid: string, output: number, amount: bigint, status = 'spent') => ({
      txid,
      output,
      amount_msat: amount,
      status,
    });
    const listed = {
      transactions: [
        // A deposit from outside: no input of ours, one output of ours.
        {
          hash: DEPOSIT,
          blockheight: 100,
          inputs: [{ txid: FOREIGN, index: 0 }],
          outputs: [{ index: 0, amount_msat: 500000000n }],
        },
        // A send: our deposit spent, 101,000 sat out (100,000 to them and 1,000 fee), change back.
        {
          hash: SEND,
          blockheight: 120,
          inputs: [{ txid: DEPOSIT, index: 0 }],
          outputs: [
            { index: 0, amount_msat: 100000000n },
            { index: 1, amount_msat: 399000000n },
          ],
        },
        // Mixed inputs (one not ours): the amount is still what left our wallet, the fee is unknown.
        {
          hash: OPEN,
          blockheight: 110,
          inputs: [
            { txid: SEND, index: 1 },
            { txid: FOREIGN, index: 1 },
          ],
          outputs: [{ index: 0, amount_msat: 600000000n }],
        },
        // An older node without inputs and outputs: nothing can be said.
        { hash: UNCONFIRMED, blockheight: 0 },
        // Spends nothing of ours and pays us nothing.
        {
          hash: CLOSE,
          blockheight: 0,
          inputs: [{ txid: FOREIGN, index: 2 }],
          outputs: [{ index: 0, amount_msat: 1n }],
        },
      ],
    };
    const { adapter: a, calls } = adapter({
      getinfo: getinfo({ blockheight: 125 }),
      listtransactions: listed,
      'bkpr-listaccountevents': nodeError(-32601, 'Unknown command'),
      listfunds: {
        outputs: [coin(DEPOSIT, 0, 500000000n), coin(SEND, 1, 399000000n), coin(OPEN, 0, 1n, 'confirmed')],
      },
    });
    const page = await a.onchain.listTransactions();
    expect(
      page.items.map((t) => [t.txid, t.kind, t.amount?.direction, t.amount?.value, t.fee, t.confirmations]),
    ).toEqual([
      [CLOSE, 'other', 'in', 0n, undefined, 0],
      [UNCONFIRMED, 'other', undefined, undefined, undefined, 0],
      [SEND, 'send', 'out', 101000000n, 1000000n, 6],
      [OPEN, 'send', 'out', 398999999n, undefined, 16],
      [DEPOSIT, 'receive', 'in', 500000000n, undefined, 26],
    ]);
    expect(calls.find((c) => c.command === 'listfunds')?.params).toEqual({ spent: true });
    expect(calls.find((c) => c.command === 'listfunds')?.rune).toBe('VIEW');
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
