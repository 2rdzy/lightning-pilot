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

  // One pass over every `unknown` intent that is due. Returns how many are still unknown.
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
    const wall = Date.now();
    const known = new Set(pending.map((intent) => intent.id));
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
    for (const [nodeId, intents] of byNode) {
      if (this.#stopped) break;
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
        unresolved += intents.length;
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
