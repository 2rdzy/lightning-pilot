// Restore reconciliation (update and rollback spec §4): after the database was restored from a backup, it does not
// know the spends made after the backup. For each node identity the restore left pending, this counts from the node
// every spend of the last 24 hours that no intent in the database covers, and adds it to the rolling window until 24
// hours after the restore. It over-counts on purpose: payments by other apps on the node are counted too (on a
// normal start they are not, spend policy §2). Anything the node cannot tell keeps spending refused (fail closed).
import { msat, toMsatString, type NodeAdapter, type Page, type PageRequest } from '@lightning-pilot/core';
import type { Db } from '../../../storage/db.ts';
import type { Logger } from '../../../logging/logger.ts';

const DAY_MS = 86_400_000;
// About 24 hours of blocks: on-chain sends are dated by their block, unconfirmed ones always count.
const DAY_BLOCKS = 144;
// Intents in these states are already in the window (policy.ts); a failed one is not, so a later spend of the same
// hash or txid that the restore lost is counted.
const COUNTED = ['reserved', 'sent', 'succeeded', 'unknown'];

export interface PendingCount {
  restore_id: string;
  chain: string;
  pubkey: string;
  recorded_at: string;
}

async function all<T>(list: (page?: PageRequest) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

// Returns 'counted', or 'unknown' when the node's history cannot be counted (spending stays refused).
export async function countRestore(
  db: Db,
  adapter: NodeAdapter,
  pending: PendingCount,
  now: Date,
  log: Logger,
): Promise<'counted' | 'unknown'> {
  const since = Date.parse(pending.recorded_at) - DAY_MS;
  const known = await db
    .selectFrom('spend_intents')
    .select(['payment_hash', 'txid'])
    .where('chain', '=', pending.chain)
    .where('pubkey', '=', pending.pubkey)
    .where('state', 'in', COUNTED)
    .execute();
  const hashes = new Set(known.flatMap((i) => (i.payment_hash === null ? [] : [i.payment_hash])));
  const txids = new Set(known.flatMap((i) => (i.txid === null ? [] : [i.txid])));

  let lightning = 0n;
  let payments = 0;
  for (const payment of await all((page) => adapter.pay.listPayments(page))) {
    if (payment.status !== 'succeeded' && payment.status !== 'pending') continue;
    // A payment without a time is counted: it may be recent.
    if (payment.createdAt !== undefined && Date.parse(payment.createdAt) <= since) continue;
    if (hashes.has(payment.paymentHash)) continue;
    // A pending payment's amountSent covers only the parts sent so far: take the larger of the two.
    const { amount, amountSent } = payment;
    const value =
      amount === undefined ? amountSent : amountSent === undefined || amount > amountSent ? amount : amountSent;
    if (value === undefined) {
      log.warn('spend restore: a payment has no amount', { paymentHash: payment.paymentHash, security: true });
      return 'unknown';
    }
    lightning += value;
    payments += 1;
  }

  const tip = (await adapter.node.getInfo()).blockHeight;
  let onchain = 0n;
  let sends = 0;
  for (const tx of await all((page) => adapter.onchain.listTransactions(page))) {
    const recent = tx.confirmations === 0 || (tx.blockHeight !== undefined && tx.blockHeight > tip - DAY_BLOCKS);
    if (!recent || txids.has(tx.txid)) continue;
    if (tx.amount === undefined) {
      log.warn('spend restore: an on-chain transaction has no amount', { txid: tx.txid, security: true });
      return 'unknown';
    }
    if (tx.amount.direction !== 'out') continue;
    onchain += tx.amount.value;
    sends += 1;
  }

  const counted = msat(lightning + onchain);
  const result = await db
    .updateTable('restore_counts')
    .set({ state: 'counted', counted_msat: toMsatString(counted), counted_at: now.toISOString() })
    .where('restore_id', '=', pending.restore_id)
    .where('chain', '=', pending.chain)
    .where('pubkey', '=', pending.pubkey)
    .where('state', '=', 'pending')
    .executeTakeFirst();
  if (result.numUpdatedRows > 0n)
    log.warn('spend restore counted', {
      restoreId: pending.restore_id,
      security: true,
      chain: pending.chain,
      identity: pending.pubkey,
      countedMsat: toMsatString(counted),
      payments,
      onchainSends: sends,
    });
  return 'counted';
}
