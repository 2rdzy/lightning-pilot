// On-chain history. `listtransactions` lists the wallet's transactions but has no amounts, fees or direction; the
// bookkeeper plugin's account events have them (reference pass, B6). Per transaction: the wallet's deposits whose
// outpoint is in it, minus the wallet's withdrawals it spends, give the net amount; `onchain_fee` events give the
// fee; channel events tell opens and closes apart. Without the bookkeeper, the raw list comes back without amounts.
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
import { AccountEvents, GetInfo, ListTransactions } from './schemas.ts';

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
  // Newest first: unconfirmed, then by height.
  items.sort((a, b) => (b.blockHeight ?? Infinity) - (a.blockHeight ?? Infinity) || a.txid.localeCompare(b.txid));
  return offsetPage(items, page);
}
