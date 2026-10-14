import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { tempDir, testDb, testDriver } from '../../testing.ts';
import { usedBudget } from './policy.ts';
it('50 parallel real reservations on independent connections never exceed the shared rolling budget', async () => {
  const t = tempDir();
  const { db } = await testDb(t.dir);
  const workers: Worker[] = [];
  const now = new Date().toISOString();
  try {
    await db
      .insertInto('nodes')
      .values({
        id: 'node',
        name: 'node',
        chain: 'blake2b',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://node.test',
        ca_certificate: 'test',
        server_name: 'localhost',
        pubkey: 'reservation-node',
        identity_state: 'confirmed',
        identity_failed_check: null,
        identity_detail: null,
        identity_checked_at: now,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('spend_limits')
      .values({
        chain: 'blake2b',
        pubkey: 'reservation-node',
        max_per_payment_sat: null,
        max_24h_sat: '10',
        step_up_above_sat: null,
        max_fee_rate: '10',
        max_fee_share_percent: 5,
        max_routing_fee_share_percent: 1,
        routing_fee_allowance_sat: '10',
      })
      .execute();
    const results: Promise<string>[] = [],
      ready: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      const worker = new Worker(new URL('./fixtures/reservation-worker.mjs', import.meta.url), {
        workerData: { file: join(t.dir, 'test.db'), driver: testDriver(), now, id: `intent-${i}` },
      });
      workers.push(worker);
      ready.push(
        new Promise((resolve, reject) => {
          worker.once('message', () => resolve());
          worker.once('error', reject);
        }),
      );
      results.push(
        new Promise((resolve, reject) => {
          worker.on('message', (value) => {
            if (value !== 'ready') resolve(String(value));
          });
          worker.once('error', reject);
        }),
      );
    }
    await Promise.all(ready);
    for (const worker of workers) worker.postMessage('go');
    const values = await Promise.all(results);
    expect(values.filter((x) => x === 'reserved')).toHaveLength(10);
    expect(values.filter((x) => x === 'limit_exceeded')).toHaveLength(40);
    expect(await usedBudget(db, { chain: 'blake2b', pubkey: 'reservation-node' }, new Date(now))).toBe(10000n);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    await db.destroy();
    t.cleanup();
  }
}, 60000);
