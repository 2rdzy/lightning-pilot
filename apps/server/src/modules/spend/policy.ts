import { AppError, SpendPolicy, parseMsat, type Msat } from '@lightning-pilot/core';
import { writeTx, type Db } from '../../storage/db.ts';

export const SPEND_SCOPE = 'Lightning Pilot spending limits — payments made by other apps are not limited.';
export interface NodeIdentity {
  chain: string;
  pubkey: string;
}
export type SpendOperation =
  | { type: 'bolt11' | 'bolt12' | 'lnurl' | 'lightning-address' | 'keysend' | 'onchain'; amount: Msat; maxFee: Msat }
  | { type: 'channel-open'; amount: Msat; push: Msat; maxFee: Msat }
  | { type: 'channel-close'; localBalance: Msat; maxFee: Msat; external: boolean; force: boolean }
  | { type: 'fee-bump' | 'rebalance'; maxFee: Msat }
  | { type: 'action'; cost?: () => Msat };

// Even credential-only mutations must explicitly declare zero; unknown spending actions fail closed.
export function spendCost(operation: SpendOperation): Msat {
  let value: bigint;
  switch (operation.type) {
    case 'action':
      if (!operation.cost) throw new AppError('validation_failed', 'This spending action has no cost function.');
      value = operation.cost();
      break;
    case 'channel-close':
      value = operation.external ? operation.localBalance + operation.maxFee : 0n;
      break;
    case 'channel-open':
      value = operation.amount + operation.push + operation.maxFee;
      break;
    case 'fee-bump':
    case 'rebalance':
      value = operation.maxFee;
      break;
    default:
      value = operation.amount + operation.maxFee;
  }
  // Do not admit a negative component disguised by another positive component.
  for (const part of Object.values(operation))
    if (typeof part === 'bigint' && part < 0n) throw new AppError('validation_failed', 'Invalid spend amount.');
  try {
    return parseMsat(value.toString());
  } catch {
    throw new AppError('validation_failed', 'Invalid spend cost.');
  }
}

export async function loadPolicy(db: Db, identity: NodeIdentity): Promise<SpendPolicy> {
  const row = await db
    .selectFrom('spend_limits')
    .selectAll()
    .where('chain', '=', identity.chain)
    .where('pubkey', '=', identity.pubkey)
    .executeTakeFirst();
  if (!row)
    throw new AppError('setup_required', 'Choose Lightning Pilot spending limits for this node before spending.', {
      reason: 'spend_policy_missing',
    });
  return SpendPolicy.parse({
    maxPerPayment: row.max_per_payment_sat,
    max24h: row.max_24h_sat,
    stepUpAbove: row.step_up_above_sat,
    maxFeeRate: row.max_fee_rate,
    maxFeeSharePercent: row.max_fee_share_percent,
    maxRoutingFeeSharePercent: row.max_routing_fee_share_percent,
    routingFeeAllowance: row.routing_fee_allowance_sat,
    maxFeeRateMode: row.max_fee_rate_mode,
    maxFeeShareMode: row.max_fee_share_mode,
    maxRoutingFeeMode: row.max_routing_fee_mode,
  });
}
export function policyValues(policy: SpendPolicy) {
  return {
    max_per_payment_sat: policy.maxPerPayment,
    max_24h_sat: policy.max24h,
    step_up_above_sat: policy.stepUpAbove,
    max_fee_rate: policy.maxFeeRate,
    max_fee_share_percent: policy.maxFeeSharePercent,
    max_routing_fee_share_percent: policy.maxRoutingFeeSharePercent,
    routing_fee_allowance_sat: policy.routingFeeAllowance,
    max_fee_rate_mode: policy.maxFeeRateMode,
    max_fee_share_mode: policy.maxFeeShareMode,
    max_routing_fee_mode: policy.maxRoutingFeeMode,
  };
}
// After a restore (modules/restore), the node's own spends since the backup are unknown until counted: spending on
// that identity is refused meanwhile (fail closed), except what costs nothing. Once counted, they add to the window.
// "Not counted yet" is the default for every identity during the 24 hours after a restore, so a node added after the
// restore (unknown to the restored database) is refused too until the recovery loop has counted it.
export async function admissionBudget(db: Db, identity: NodeIdentity, now: Date, cost: bigint): Promise<bigint> {
  if (cost > 0n) {
    const pending = await db
      .selectFrom('restores')
      .leftJoin('restore_counts', (join) =>
        join
          .onRef('restore_counts.restore_id', '=', 'restores.id')
          .on('restore_counts.chain', '=', identity.chain)
          .on('restore_counts.pubkey', '=', identity.pubkey)
          .on('restore_counts.state', '=', 'counted'),
      )
      .select('restores.id')
      .where('restores.recorded_at', '>', new Date(now.getTime() - 86_400_000).toISOString())
      .where('restore_counts.restore_id', 'is', null)
      .executeTakeFirst();
    if (pending)
      throw new AppError(
        'setup_required',
        'Spending is paused after a restore until the node has been read again. Try again shortly.',
        { reason: 'restore_reconciliation' },
      );
  }
  return usedBudget(db, identity, now);
}

export async function usedBudget(db: Db, identity: NodeIdentity, now: Date): Promise<bigint> {
  const rows = await db
    .selectFrom('spend_intents')
    .select(['cost_msat', 'amount_msat', 'max_fee_msat'])
    .where('chain', '=', identity.chain)
    .where('pubkey', '=', identity.pubkey)
    .where('state', 'in', ['reserved', 'sent', 'succeeded', 'unknown'])
    .where('created_at', '>', new Date(now.getTime() - 86400000).toISOString())
    .where('created_at', '<=', now.toISOString())
    .execute();
  const restored = await db
    .selectFrom('restore_counts')
    .select('counted_msat')
    .where('chain', '=', identity.chain)
    .where('pubkey', '=', identity.pubkey)
    .where('state', '=', 'counted')
    .where('until', '>', now.toISOString())
    .execute();
  // Legacy rows have no immutable cost; preserve their reservation conservatively.
  return rows.reduce(
    (sum, row) =>
      sum + (row.cost_msat === null ? BigInt(row.amount_msat) + BigInt(row.max_fee_msat) : BigInt(row.cost_msat)),
    restored.reduce((sum, row) => sum + BigInt(row.counted_msat ?? '0'), 0n),
  );
}
export function checkBudget(policy: SpendPolicy, used: bigint, cost: bigint): boolean {
  if (
    (policy.maxPerPayment !== null && cost > BigInt(policy.maxPerPayment) * 1000n) ||
    // A spend that costs nothing (a close to the node's own wallet) adds nothing to the window, even when the
    // owner has lowered the cap below what was already used.
    (policy.max24h !== null && cost > 0n && used + cost > BigInt(policy.max24h) * 1000n)
  )
    throw new AppError('limit_exceeded', 'This spend exceeds the Lightning Pilot spending limits.');
  return policy.stepUpAbove !== null && cost > BigInt(policy.stepUpAbove) * 1000n;
}
export function lightningFee(amount: Msat, policy: SpendPolicy, requested?: string) {
  const cap = parseMsat(
    (
      (amount * BigInt(policy.maxRoutingFeeSharePercent)) / 100n +
      BigInt(policy.routingFeeAllowance) * 1000n
    ).toString(),
  );
  const fee = requested === undefined ? cap : parseMsat(requested);
  const override = fee > cap;
  if (override && policy.maxRoutingFeeMode === 'refuse')
    throw new AppError('fee_cap_exceeded', 'The routing fee exceeds the configured cap.');
  return { fee, override };
}
// Decimal rates become integer thousandths of sat/vB, never binary floating point.
export function onchainFee(amount: Msat, fee: Msat, rate: string, policy: SpendPolicy): boolean {
  const units = (text: string) => {
    if (!/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$/.test(text))
      throw new AppError('fee_cap_exceeded', 'Invalid node fee estimate.');
    const [whole, fraction = ''] = text.split('.');
    const value = BigInt(whole as string) * 1000n + BigInt(fraction.padEnd(3, '0'));
    if (value === 0n) throw new AppError('fee_cap_exceeded', 'Invalid node fee estimate.');
    return value;
  };
  const rateExceeded = units(rate) > units(policy.maxFeeRate);
  const shareExceeded = fee * 100n > amount * BigInt(policy.maxFeeSharePercent);
  if ((rateExceeded && policy.maxFeeRateMode === 'refuse') || (shareExceeded && policy.maxFeeShareMode === 'refuse'))
    throw new AppError('fee_cap_exceeded', 'The on-chain fee exceeds the configured cap.');
  return rateExceeded || shareExceeded;
}
// The callback inserts the durable intent in the same transaction as the recheck. Never perform RPCs here.
export async function reserveSpend<T>(
  db: Db,
  identity: NodeIdentity,
  cost: Msat,
  now: Date | (() => Date),
  claim: (trx: Db, policy: SpendPolicy, stepUp: boolean) => Promise<T>,
  replay?: (trx: Db) => Promise<T | undefined>,
): Promise<T> {
  return writeTx(db, async (trx) => {
    const existing = await replay?.(trx);
    if (existing !== undefined) return existing;
    const policy = await loadPolicy(trx, identity);
    const at = typeof now === 'function' ? now() : now;
    const stepUp = checkBudget(policy, await admissionBudget(trx, identity, at, cost), cost);
    return claim(trx, policy, stepUp);
  });
}

// Future channel callers must combine force-close authority with the ordinary threshold requirement.
export function operationNeedsStepUp(operation: SpendOperation, policy: SpendPolicy, used: bigint): boolean {
  return checkBudget(policy, used, spendCost(operation)) || (operation.type === 'channel-close' && operation.force);
}
