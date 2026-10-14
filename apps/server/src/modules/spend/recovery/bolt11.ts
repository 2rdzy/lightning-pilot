// Resolves an `unknown` BOLT11 intent from the node's record of the payment, looked up by payment hash.
import { createHash } from 'node:crypto';
import {
  AdapterError,
  msat,
  parseMsat,
  toMsatString,
  type Msat,
  type NodeAdapter,
  type PaymentHash,
} from '@lightning-pilot/core';
import type { Db } from '../../../storage/db.ts';
import type { Logger } from '../../../logging/logger.ts';

// xpay keeps trying for `retry_for` seconds after the call reaches it, even when our process has gone.
export const RETRY_FOR_SECONDS = 60;
// After this long since the intent's last update, a record whose parts all failed, or no record at all, is final.
export const SETTLE_FAILED_AFTER_MS = (RETRY_FOR_SECONDS + 60) * 1000;
// "No record" is trusted only this long: the node may delete old payment records (CLN autoclean), and a deleted
// record of a payment that succeeded must never free its invoice. Older intents stay unknown; they no longer count in
// the 24-hour window, and only block their own (by then usually expired) invoice.
export const NO_RECORD_TRUSTED_FOR_MS = 86_400_000;

// A preimage is stored only when it proves the payment: 32 bytes whose SHA-256 is the payment hash.
export function provenPreimage(preimage: string | undefined, paymentHash: string): string | undefined {
  if (preimage === undefined || !/^[0-9a-f]{64}$/.test(preimage)) return undefined;
  return createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') === paymentHash ? preimage : undefined;
}

// Set by start-up recovery on intents a stopped process left reserved or sent. Only these may be failed for lack of a
// node record: an intent that became unknown at run time (an unclear or wrong node answer) did reach the node.
export const INTERRUPTED = 'interrupted';

export interface UnknownBolt11 {
  id: string;
  payment_hash: string;
  amount_msat: string;
  updated_at: string;
  error_code: string | null;
}

// Reads the node's record and stores the outcome when the record is clear: complete → succeeded; every part failed,
// or no record at all, once xpay has stopped retrying → failed. Anything else stays unknown. Only `unknown` rows are
// updated, so a row resolved meanwhile by another path is never overwritten.
export async function settleBolt11(
  db: Db,
  adapter: NodeAdapter,
  intent: UnknownBolt11,
  now: Date,
  log: Logger,
  requestId?: string,
): Promise<'succeeded' | 'failed' | 'unknown'> {
  const paymentHash = intent.payment_hash as PaymentHash;
  let record;
  try {
    record = await adapter.pay.getPayment(paymentHash);
  } catch (err) {
    log.warn('payment status not readable', {
      ...(requestId === undefined ? {} : { requestId }),
      intentId: intent.id,
      code: err instanceof AdapterError ? err.code : 'internal',
    });
    return 'unknown';
  }
  const age = now.getTime() - Date.parse(intent.updated_at);
  let state: 'succeeded' | 'failed' | undefined;
  let fee: Msat | undefined;
  let preimage: string | undefined;
  if (record?.status === 'succeeded') {
    state = 'succeeded';
    const amount = parseMsat(intent.amount_msat);
    if (record.amountSent !== undefined && record.amountSent >= amount) fee = msat(record.amountSent - amount);
    preimage = provenPreimage(record.preimage, paymentHash);
  } else if (record?.status === 'failed' && age >= SETTLE_FAILED_AFTER_MS) {
    state = 'failed';
  } else if (
    record === undefined &&
    intent.error_code === INTERRUPTED &&
    age >= SETTLE_FAILED_AFTER_MS &&
    age < NO_RECORD_TRUSTED_FOR_MS
  ) {
    // xpay stores our intent id as the label: a record under it with another hash means the node paid something.
    try {
      if ((await adapter.pay.listByLabel(intent.id)).length > 0) return 'unknown';
    } catch {
      return 'unknown';
    }
    state = 'failed';
  }
  if (state === undefined) return 'unknown';
  const result = await db
    .updateTable('spend_intents')
    .set({
      state,
      ...(fee === undefined ? {} : { fee_msat: toMsatString(fee) }),
      ...(preimage === undefined ? {} : { preimage }),
      ...(state === 'failed' && record === undefined ? { error_code: 'not_on_node' } : {}),
      ...(state === 'succeeded' && intent.error_code === INTERRUPTED ? { error_code: null } : {}),
      updated_at: now.toISOString(),
    })
    .where('id', '=', intent.id)
    .where('state', '=', 'unknown')
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    // Resolved meanwhile by another path: report what is stored now.
    const stored = await db.selectFrom('spend_intents').select('state').where('id', '=', intent.id).executeTakeFirst();
    return stored?.state === 'succeeded' || stored?.state === 'failed' ? stored.state : 'unknown';
  }
  log.info('spend settled', {
    ...(requestId === undefined ? {} : { requestId }),
    intentId: intent.id,
    security: true,
    paymentHash,
    state,
    ...(fee === undefined ? {} : { feeMsat: toMsatString(fee) }),
  });
  return state;
}
