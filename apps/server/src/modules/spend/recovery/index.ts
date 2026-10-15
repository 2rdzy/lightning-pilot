// Crash recovery (spend policy §4). At start-up, before the listener opens, every intent a dead process left in
// `reserved` or `sent` becomes `unknown`: it may have reached the node. A background loop then reads each `unknown`
// intent's outcome from its node, per spend type, until it is resolved. `unknown` intents keep counting against the
// limits and keep blocking their own payment, so nothing is spent twice while a node cannot be asked.
import { AdapterError, AppError } from '@lightning-pilot/core';
import type { Db } from '../../../storage/db.ts';
import type { Logger } from '../../../logging/logger.ts';
import type { NodesService } from '../../nodes/index.ts';
import type { Vault } from '../../vault/index.ts';
import { INTERRUPTED, settleBolt11 } from './bolt11.ts';
import { settleChainSpend } from './chain.ts';
import { countRestore, type PendingCount } from './restore.ts';

export { settleBolt11, provenPreimage, RETRY_FOR_SECONDS, SETTLE_FAILED_AFTER_MS } from './bolt11.ts';

const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 600_000;

export interface RecoveryOptions {
  db: Db;
  nodes: NodesService;
  // Opens the sealed PSBT of an on-chain send, to release its inputs.
  vault: Vault;
  logger: Logger;
  now?: () => Date;
}

export class SpendRecovery {
  readonly #db: Db;
  readonly #nodes: NodesService;
  readonly #vault: Vault;
  readonly #log: Logger;
  readonly #now: () => Date;
  // Next attempt and current delay per intent; in memory, so a restart asks the node again at once.
  readonly #backoff = new Map<string, { next: number; delay: number }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(options: RecoveryOptions) {
    this.#db = options.db;
    this.#nodes = options.nodes;
    this.#vault = options.vault;
    this.#log = options.logger.child('spend');
    this.#now = options.now ?? (() => new Date());
  }

  // Only one server process owns the database (the service lock in main.ts), so every `reserved` or `sent` intent
  // at start-up belongs to a process that died. Call before the listener opens.
  async markUnresolved(): Promise<number> {
    const result = await this.#db
      .updateTable('spend_intents')
      .set({ state: 'unknown', error_code: INTERRUPTED })
      .where('state', 'in', ['reserved', 'sent'])
      .executeTakeFirst();
    const count = Number(result.numUpdatedRows);
    if (count > 0) this.#log.warn('spend intents interrupted by a stop', { count, security: true });
    return count;
  }

  // Starts the background loop: one pass now, then one whenever an intent is due. A second call is ignored.
  start(): void {
    if (this.#timer !== undefined || this.#running !== undefined || this.#stopped) return;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  // One pass over every `unknown` intent, and every node identity a restore left to count, that is due. Returns how
  // many are still unresolved (intents plus restore counts).
  async resolvePass(): Promise<number> {
    const pending = await this.#db
      .selectFrom('spend_intents')
      .select([
        'id',
        'node_id',
        'chain',
        'pubkey',
        'type',
        'payment_hash',
        'amount_msat',
        'updated_at',
        'error_code',
        'txid',
        'psbt_key_id',
        'psbt_nonce',
        'psbt_ciphertext',
        'channel_id',
        'peer',
      ])
      .where('state', '=', 'unknown')
      .orderBy('created_at')
      .execute();
    // Every node identity needs a count after a recent restore, also one added since (the restored database did not
    // know it): its missing row is created here, pending.
    const since = new Date(this.#now().getTime() - 86_400_000).toISOString();
    for (const restore of await this.#db
      .selectFrom('restores')
      .select(['id', 'recorded_at'])
      .where('recorded_at', '>', since)
      .execute())
      for (const identity of await this.#db.selectFrom('nodes').select(['chain', 'pubkey']).distinct().execute())
        await this.#db
          .insertInto('restore_counts')
          .values({
            restore_id: restore.id,
            chain: identity.chain,
            pubkey: identity.pubkey,
            state: 'pending',
            counted_msat: null,
            counted_at: null,
            until: new Date(Date.parse(restore.recorded_at) + 86_400_000).toISOString(),
          })
          .onConflict((conflict) => conflict.doNothing())
          .execute();
    const counts = await this.#db
      .selectFrom('restore_counts')
      .innerJoin('restores', 'restores.id', 'restore_counts.restore_id')
      .select(['restore_counts.restore_id', 'restore_counts.chain', 'restore_counts.pubkey', 'restores.recorded_at'])
      .where('restore_counts.state', '=', 'pending')
      .where('restore_counts.until', '>', this.#now().toISOString())
      .execute();
    const countKey = (c: PendingCount) => `restore:${c.restore_id}:${c.chain}:${c.pubkey}`;
    const wall = Date.now();
    const known = new Set([...pending.map((intent) => intent.id), ...counts.map(countKey)]);
    for (const id of this.#backoff.keys()) if (!known.has(id)) this.#backoff.delete(id);
    let unresolved = 0;
    const byNode = new Map<string, typeof pending>();
    for (const intent of pending) {
      const due = this.#backoff.get(intent.id);
      if (due && due.next > wall) {
        unresolved += 1;
        continue;
      }
      byNode.set(intent.node_id, [...(byNode.get(intent.node_id) ?? []), intent]);
    }
    // A restore count is read from any node record of that identity (one is enough).
    const countsByNode = new Map<string, PendingCount[]>();
    for (const count of counts) {
      const due = this.#backoff.get(countKey(count));
      const node = await this.#db
        .selectFrom('nodes')
        .select('id')
        .where('chain', '=', count.chain)
        .where('pubkey', '=', count.pubkey)
        .orderBy('created_at')
        .executeTakeFirst();
      // No node of that identity any more: nothing can be spent there; the row expires with its window.
      if ((due && due.next > wall) || !node) {
        unresolved += 1;
        continue;
      }
      countsByNode.set(node.id, [...(countsByNode.get(node.id) ?? []), count]);
    }
    for (const nodeId of new Set([...byNode.keys(), ...countsByNode.keys()])) {
      if (this.#stopped) break;
      const intents = byNode.get(nodeId) ?? [];
      const restores = countsByNode.get(nodeId) ?? [];
      let adapter;
      try {
        // Only a node confirmed on its chain is asked: a node record pointing at the same key on the other chain
        // has no record of our payment, and "no record" may fail an intent.
        const loaded = await this.#nodes.adapter(nodeId);
        await this.#nodes.monitor.ensureChecked(nodeId);
        const reloaded = await this.#db
          .selectFrom('nodes')
          .selectAll()
          .where('id', '=', nodeId)
          .executeTakeFirstOrThrow();
        const identity = this.#nodes.identity(reloaded);
        if (identity.state !== 'confirmed')
          throw new AppError(
            identity.state === 'waiting' ? 'chain_waiting' : 'chain_refused',
            'Not confirmed on its chain.',
          );
        adapter = loaded.adapter;
      } catch (err) {
        this.#log.warn('spend recovery: node not available', {
          nodeId,
          code: err instanceof AdapterError || err instanceof AppError ? err.code : 'internal',
        });
        for (const intent of intents) this.#later(intent.id, wall);
        for (const count of restores) this.#later(countKey(count), wall);
        unresolved += intents.length + restores.length;
        continue;
      }
      for (const intent of intents) {
        let state: string = 'unknown';
        if (intent.type === 'bolt11' && intent.payment_hash !== null)
          state = await settleBolt11(
            this.#db,
            adapter,
            { ...intent, payment_hash: intent.payment_hash },
            this.#now(),
            this.#log,
          );
        else if (intent.type === 'onchain' || intent.type === 'channel-open' || intent.type === 'channel-close')
          state = await settleChainSpend(
            this.#db,
            adapter,
            this.#vault,
            { ...intent, type: intent.type },
            this.#now(),
            this.#log,
          );
        else
          this.#log.warn('spend recovery: no resolver for this spend type', { intentId: intent.id, type: intent.type });
        if (state === 'unknown') {
          this.#later(intent.id, wall);
          unresolved += 1;
        } else {
          this.#backoff.delete(intent.id);
        }
      }
      // After the intents: an intent settled just now is in the window already and is not counted twice.
      for (const count of restores) {
        let state: 'counted' | 'unknown' = 'unknown';
        try {
          state = await countRestore(this.#db, adapter, count, this.#now(), this.#log);
        } catch (err) {
          this.#log.warn('spend restore: node history not readable', {
            nodeId,
            code: err instanceof AdapterError ? err.code : 'internal',
          });
        }
        if (state === 'unknown') {
          this.#later(countKey(count), wall);
          unresolved += 1;
        } else this.#backoff.delete(countKey(count));
      }
    }
    return unresolved;
  }

  #later(id: string, wall: number): void {
    const delay = Math.min((this.#backoff.get(id)?.delay ?? FIRST_RETRY_MS / 2) * 2, MAX_RETRY_MS);
    this.#backoff.set(id, { next: wall + delay, delay });
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.resolvePass()
        .catch((err: unknown) => {
          this.#log.error('spend recovery pass failed', { message: err instanceof Error ? err.message : 'unknown' });
        })
        .then(() => {
          this.#running = undefined;
          const next = Math.min(...[...this.#backoff.values()].map((b) => b.next), Date.now() + MAX_RETRY_MS);
          // Intents that become unknown at run time (an unclear node answer) are picked up by the next pass.
          this.#schedule(Math.max(Math.min(next - Date.now(), FIRST_RETRY_MS), 1000));
        });
    }, ms);
    this.#timer.unref();
  }
}
