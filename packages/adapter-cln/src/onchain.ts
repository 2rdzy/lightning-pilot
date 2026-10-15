// On-chain history. `listtransactions` lists the wallet's transactions but has no amounts, fees or direction; the
// bookkeeper plugin's account events have them (reference pass, B6). Per transaction: the wallet's deposits whose
// outpoint is in it, minus the wallet's withdrawals it spends, give the net amount; `onchain_fee` events give the
// fee; channel events tell opens and closes apart. Without the bookkeeper, the wallet's own coins (listfunds with
// spent ones) give the amount: our coins a transaction spends minus our coins it creates. That is exact for the wallet
// (it is what left it, fee included); the fee itself is known only when every input is ours. Restore reconciliation
// counts these amounts, so a missing one must never be guessed low.
import {
  AdapterError,
  msat,
  parseTxid,
  type OnchainTx,
  type OnchainTxKind,
  type Page,
  type PageRequest,
} from '@lightning-pilot/core';
import { checkOffsetPage, offsetPage, parse, type Call } from './context.ts';
import { AccountEvents, GetInfo, ListFunds, ListTransactions } from './schemas.ts';

// "Unknown command": the bookkeeper plugin is not running.
const UNKNOWN_COMMAND = -32601;

interface TxFacts {
  height: number;
  credit: bigint;
  debit: bigint;
  fee: bigint;
  hasFee: boolean;
  // listtransactions lists it (a wallet transaction).
  listed: boolean;
  // The bookkeeper has wallet events for it (unconfirmed transactions may have none yet).
  booked: boolean;
  kind?: OnchainTxKind;
}

export async function listTransactions(call: Call, page: PageRequest | undefined): Promise<Page<OnchainTx>> {
  checkOffsetPage(page);
  const tip = parse(GetInfo, await call('getinfo', {})).blockheight;
  const { transactions } = parse(ListTransactions, await call('listtransactions', {}));
  let events: (typeof AccountEvents)['_output']['events'] | undefined;
  try {
    events = parse(AccountEvents, await call('bkpr-listaccountevents', {})).events;
  } catch (err) {
    if (!(err instanceof AdapterError && err.nodeCode === UNKNOWN_COMMAND)) throw err;
  }

  if (events === undefined) return offsetPage(fromCoins(transactions, tip, await coinsOf(call)), page);

  const facts = new Map<string, TxFacts>();
  const factsOf = (txid: string) => {
    let f = facts.get(txid);
    if (!f) {
      f = { height: 0, credit: 0n, debit: 0n, fee: 0n, hasFee: false, listed: false, booked: false };
      facts.set(txid, f);
    }
    return f;
  };
  for (const tx of transactions) {
    const f = factsOf(tx.hash);
    f.height = tx.blockheight;
    f.listed = true;
  }

  for (const e of events ?? []) {
    const outpointTx = e.outpoint?.split(':')[0];
    if (e.account === 'wallet' && e.type === 'chain') {
      if (e.tag === 'deposit' && outpointTx) {
        const f = factsOf(outpointTx);
        f.credit += e.credit_msat;
        f.booked = true;
        if (e.blockheight !== undefined && f.height === 0) f.height = e.blockheight;
      } else if (e.tag === 'withdrawal' && e.txid) {
        const f = factsOf(e.txid);
        f.debit += e.debit_msat;
        f.booked = true;
      }
    } else if (e.account === 'wallet' && e.type === 'onchain_fee' && e.txid) {
      const f = factsOf(e.txid);
      f.fee += e.credit_msat - e.debit_msat;
      f.hasFee = true;
    } else if (e.type === 'chain' && e.tag === 'channel_open' && outpointTx) {
      factsOf(outpointTx).kind = 'channel-open';
    } else if (e.type === 'chain' && e.tag === 'channel_close' && e.txid) {
      factsOf(e.txid).kind = 'channel-close';
    }
  }

  const items: OnchainTx[] = [];
  for (const [txid, f] of facts) {
    // Transactions only the bookkeeper knows that never touched the wallet (a peer's commitment, say) are left out.
    if (!f.listed && !f.booked && f.kind === undefined) continue;
    const net = f.credit - f.debit;
    const kind: OnchainTxKind = f.kind ?? (!f.booked ? 'other' : net > 0n ? 'receive' : net < 0n ? 'send' : 'other');
    items.push({
      txid: parseTxid(txid),
      ...(f.booked ? { amount: { direction: net >= 0n ? 'in' : 'out', value: msat(net >= 0n ? net : -net) } } : {}),
      ...(f.hasFee && f.fee >= 0n ? { fee: msat(f.fee) } : {}),
      ...(f.height > 0 ? { blockHeight: f.height } : {}),
      confirmations: f.height > 0 && f.height <= tip ? tip - f.height + 1 : 0,
      kind,
    });
  }
  // The bookkeeper books a transaction only once it is seen in a block: a just-broadcast send of ours has no events
  // yet. Its amount comes from the wallet's coins instead, so a recent send is never without one.
  const unbooked = transactions.filter((tx) => facts.get(tx.hash)?.booked === false);
  if (unbooked.length > 0) {
    const counted = new Map(fromCoins(unbooked, tip, await coinsOf(call)).map((t) => [t.txid as string, t]));
    for (const [i, item] of items.entries()) {
      const from = counted.get(item.txid);
      if (from?.amount === undefined) continue;
      items[i] = {
        ...item,
        amount: from.amount,
        ...(item.fee === undefined && from.fee !== undefined ? { fee: from.fee } : {}),
        ...(item.kind === 'other' ? { kind: from.kind } : {}),
      };
    }
  }
  // Newest first: unconfirmed, then by height.
  items.sort((a, b) => (b.blockHeight ?? Infinity) - (a.blockHeight ?? Infinity) || a.txid.localeCompare(b.txid));
  return offsetPage(items, page);
}

// Every coin the wallet has had, spent ones included, by outpoint.
async function coinsOf(call: Call): Promise<Map<string, bigint>> {
  const { outputs } = parse(ListFunds, await call('listfunds', { spent: true }));
  return new Map(outputs.map((o) => [`${o.txid}:${o.output}`, o.amount_msat]));
}

function fromCoins(
  transactions: (typeof ListTransactions)['_output']['transactions'],
  tip: number,
  coins: Map<string, bigint>,
): OnchainTx[] {
  const items = transactions.map((tx): OnchainTx => {
    const base = {
      txid: parseTxid(tx.hash),
      ...(tx.blockheight > 0 ? { blockHeight: tx.blockheight } : {}),
      confirmations: tx.blockheight > 0 && tx.blockheight <= tip ? tip - tx.blockheight + 1 : 0,
    };
    // Without inputs and outputs (an older node) nothing can be said.
    if (tx.inputs === undefined || tx.outputs === undefined) return { ...base, kind: 'other' };
    const spent = tx.inputs.map((i) => coins.get(`${i.txid}:${i.index}`));
    const debit = spent.reduce<bigint>((sum, v) => sum + (v ?? 0n), 0n);
    const credit = tx.outputs.reduce<bigint>((sum, o) => sum + (coins.get(`${tx.hash}:${o.index}`) ?? 0n), 0n);
    const net = credit - debit;
    const allOurs = spent.length > 0 && spent.every((v) => v !== undefined);
    const fee = allOurs ? debit - tx.outputs.reduce<bigint>((sum, o) => sum + o.amount_msat, 0n) : undefined;
    return {
      ...base,
      amount: { direction: net >= 0n ? 'in' : 'out', value: msat(net >= 0n ? net : -net) },
      ...(fee !== undefined && fee >= 0n ? { fee: msat(fee) } : {}),
      kind: net > 0n ? 'receive' : net < 0n ? 'send' : 'other',
    };
  });
  items.sort((a, b) => (b.blockHeight ?? Infinity) - (a.blockHeight ?? Infinity) || a.txid.localeCompare(b.txid));
  return items;
}
