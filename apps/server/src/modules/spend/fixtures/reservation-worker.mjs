import { parentPort, workerData } from 'node:worker_threads';
import { kyselyOf, openRaw } from '../../../storage/db.ts';
import { reserveSpend } from '../policy.ts';
import { msat } from '@lightning-pilot/core';
const db = kyselyOf(await openRaw(workerData.file, workerData.driver));
parentPort.postMessage('ready');
await new Promise((resolve) => parentPort.once('message', resolve));
try {
  await reserveSpend(
    db,
    { chain: 'blake2b', pubkey: 'reservation-node' },
    msat(1000n),
    new Date(workerData.now),
    async (trx) => {
      await trx
        .insertInto('spend_intents')
        .values({
          id: workerData.id,
          node_id: 'node',
          chain: 'blake2b',
          pubkey: 'reservation-node',
          type: 'bolt11',
          payment_hash: workerData.id,
          amount_msat: '1000',
          max_fee_msat: '0',
          cost_msat: '1000',
          fee_msat: null,
          state: 'reserved',
          idempotency_key: workerData.id,
          digest: 'digest',
          error_code: null,
          created_at: workerData.now,
          updated_at: workerData.now,
        })
        .execute();
    },
  );
  parentPort.postMessage('reserved');
} catch (error) {
  parentPort.postMessage(error.code ?? error.message);
} finally {
  await db.destroy();
}
