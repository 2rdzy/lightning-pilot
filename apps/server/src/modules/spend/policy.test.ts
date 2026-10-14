import { afterEach, expect, it } from 'vitest';
import { msat, SpendPolicy } from '@lightning-pilot/core';
import { tempDir, testDb } from '../../testing.ts';
import {
  checkBudget,
  lightningFee,
  onchainFee,
  loadPolicy,
  policyValues,
  usedBudget,
  reserveSpend,
  spendCost,
  operationNeedsStepUp,
  type SpendOperation,
} from './policy.ts';
const policy = SpendPolicy.parse({
  maxPerPayment: '100',
  max24h: '200',
  stepUpAbove: '50',
  maxFeeRate: '10.125',
  maxFeeSharePercent: 5,
  maxRoutingFeeSharePercent: 1,
  routingFeeAllowance: '10',
});
const id = { chain: 'blake2b', pubkey: 'pubkey' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
async function database() {
  const t = tempDir();
  const { db } = await testDb(t.dir);
  cleanups.push(async () => {
    await db.destroy();
    t.cleanup();
  });
  return db;
}
it('computes the cost of every fund-moving operation and refuses undeclared actions', () => {
  for (const type of ['bolt11', 'bolt12', 'lnurl', 'lightning-address', 'keysend', 'onchain'] as const)
    expect(spendCost({ type, amount: msat(100n), maxFee: msat(10n) })).toBe(110n);
  const cases: [SpendOperation, bigint][] = [
    [{ type: 'channel-open', amount: msat(100n), push: msat(20n), maxFee: msat(10n) }, 130n],
    [{ type: 'channel-close', external: true, force: false, localBalance: msat(100n), maxFee: msat(10n) }, 110n],
    [{ type: 'channel-close', external: false, force: true, localBalance: msat(100n), maxFee: msat(10n) }, 0n],
    [{ type: 'fee-bump', maxFee: msat(10n) }, 10n],
    [{ type: 'rebalance', maxFee: msat(10n) }, 10n],
    [{ type: 'action', cost: () => msat(0n) }, 0n],
  ];
  for (const [operation, cost] of cases) expect(spendCost(operation)).toBe(cost);
  expect(() => spendCost({ type: 'action' })).toThrow('no cost function');
  expect(() => spendCost({ type: 'action', cost: () => -1n as ReturnType<typeof msat> })).toThrow('Invalid spend cost');
  expect(() => spendCost({ type: 'bolt11', amount: -1n as ReturnType<typeof msat>, maxFee: msat(10n) })).toThrow(
    'Invalid spend amount',
  );
});
it('uses exact inclusive caps and a strictly-above step-up threshold', () => {
  expect(checkBudget(policy, 100000n, 100000n)).toBe(true);
  expect(checkBudget(policy, 0n, 50000n)).toBe(false);
  expect(() => checkBudget(policy, 0n, 100001n)).toThrow('exceeds');
  expect(() => checkBudget(policy, 200000n, 1n)).toThrow('exceeds');
  expect(checkBudget({ ...policy, maxPerPayment: null, max24h: null, stepUpAbove: null }, 999999n, 999999n)).toBe(
    false,
  );
});
it('adds the tiny-payment allowance and binds fee overrides to explicit policy', () => {
  expect(lightningFee(msat(101n), policy)).toEqual({ fee: 10001n, override: false });
  expect(lightningFee(msat(100n), policy, '0')).toEqual({ fee: 0n, override: false });
  expect(() => lightningFee(msat(100n), policy, '10002')).toThrow('cap');
  expect(lightningFee(msat(100n), { ...policy, maxRoutingFeeMode: 'step-up' }, '10002').override).toBe(true);
});
it('validates node fee estimates and applies independent on-chain caps without floating point', () => {
  expect(onchainFee(msat(100000n), msat(5000n), '10.125', policy)).toBe(false);
  for (const rate of ['0', 'NaN', 'Infinity', '-1', '10000000', '1.0001'])
    expect(() => onchainFee(msat(100000n), msat(1n), rate, policy)).toThrow();
  expect(() => onchainFee(msat(100000n), msat(1n), '10.126', policy)).toThrow('cap');
  expect(() => onchainFee(msat(100000n), msat(5001n), '1', policy)).toThrow('cap');
  expect(
    onchainFee(msat(100n), msat(100n), '11', { ...policy, maxFeeRateMode: 'step-up', maxFeeShareMode: 'step-up' }),
  ).toBe(true);
});
it('fails closed without policy, rechecks changed policy and rolls back a failed claim', async () => {
  const db = await database();
  await expect(loadPolicy(db, id)).rejects.toMatchObject({ code: 'setup_required' });
  await db
    .insertInto('spend_limits')
    .values({ ...id, ...policyValues(policy) })
    .execute();
  expect(await loadPolicy(db, id)).toEqual(policy);
  await expect(
    reserveSpend(db, id, msat(1n), new Date(), async () => {
      throw new Error('claim failed before RPC');
    }),
  ).rejects.toThrow('claim failed');
  expect(await usedBudget(db, id, new Date())).toBe(0n);
  await db.updateTable('spend_limits').set({ max_per_payment_sat: '0', step_up_above_sat: '0' }).execute();
  await expect(reserveSpend(db, id, msat(1n), new Date(), async () => 'wrong')).rejects.toMatchObject({
    code: 'limit_exceeded',
  });
  expect(
    await reserveSpend(
      db,
      id,
      msat(1n),
      new Date(),
      async () => 'wrong',
      async () => 'replayed',
    ),
  ).toBe('replayed');
});

it('force close requires authority even when the owner-wallet cost is zero', () => {
  const close = {
    type: 'channel-close' as const,
    external: false,
    localBalance: msat(100n),
    maxFee: msat(1n),
    force: true,
  };
  expect(operationNeedsStepUp(close, policy, 0n)).toBe(true);
  expect(operationNeedsStepUp({ ...close, force: false }, policy, 0n)).toBe(false);
  expect(operationNeedsStepUp({ type: 'keysend', amount: msat(60000n), maxFee: msat(0n) }, policy, 0n)).toBe(true);
});
it('counts only the rolling 24-hour window across midnight and shares identity across node records', async () => {
  const db = await database();
  const now = new Date('2026-10-14T00:00:00.000Z');
  await db
    .insertInto('nodes')
    .values({
      id: 'node',
      name: 'node',
      chain: id.chain,
      network: 'regtest',
      implementation: 'cln',
      url: 'https://node.test',
      ca_certificate: 'test',
      server_name: 'localhost',
      pubkey: id.pubkey,
      identity_state: 'confirmed',
      identity_failed_check: null,
      identity_detail: null,
      identity_checked_at: now.toISOString(),
      created_at: now.toISOString(),
    })
    .execute();
  const insert = async (name: string, created: string, state: string, cost: string | null, chain = id.chain) =>
    db
      .insertInto('spend_intents')
      .values({
        id: name,
        node_id: 'node',
        chain,
        pubkey: id.pubkey,
        type: 'bolt11',
        payment_hash: name,
        amount_msat: '100',
        max_fee_msat: '10',
        cost_msat: cost,
        fee_msat: null,
        state,
        idempotency_key: name,
        digest: 'digest',
        error_code: null,
        created_at: created,
        updated_at: created,
      })
      .execute();
  await insert('old', '2026-10-13T00:00:00.000Z', 'succeeded', '500');
  await insert('new', '2026-10-13T00:00:00.001Z', 'succeeded', '21');
  await insert('unknown', '2026-10-13T23:59:59.999Z', 'unknown', '32');
  await insert('legacy', now.toISOString(), 'reserved', null);
  await insert('failed', now.toISOString(), 'failed', '999');
  await insert('other-chain', now.toISOString(), 'sent', '999', 'bitcoin');
  await insert('future', '2026-10-14T00:00:00.001Z', 'sent', '999');
  expect(await usedBudget(db, id, now)).toBe(163n);
  expect(await usedBudget(db, { ...id, chain: 'bitcoin' }, now)).toBe(999n);
  await db.updateTable('spend_intents').set({ amount_msat: '999999' }).where('id', '=', 'new').execute();
  expect(await usedBudget(db, id, now)).toBe(163n);
});
