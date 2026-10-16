// Spends whose outcome stays unknown, and the owner's way to settle one by hand (spend policy §13). Recovery leaves a
// spend unknown when the node cannot tell: for example a payment interrupted more than 24 hours ago, whose record the
// node may have deleted. Such a spend blocks its own payment for ever. The owner, who can look at the node or the
// recipient, chooses the outcome, with security step-up; the choice is a security log line.
import { AppError, AdapterError, parseTxid, type Txid } from '@lightning-pilot/core';
import { writeTx, type Db } from '../../storage/db.ts';
import type { Logger } from '../../logging/logger.ts';
import type { AuthService } from '../auth/index.ts';
import type { NodesService } from '../nodes/index.ts';
import type { Vault } from '../vault/index.ts';
import { liveSession } from './common.ts';

export const NOT_PAID_WARNING =
  'Only mark a spend as failed when you are sure no funds left the node. A wrong choice frees its share of the ' +
  'spending limits, and for a payment lets the same invoice be paid a second time.';
// Set on an intent the owner resolved, so the log and the history tell it from one the node confirmed.
export const OWNER_RESOLVED = 'owner_resolved';

export interface ResolveOptions {
  db: Db;
  nodes: NodesService;
  auth: AuthService;
  vault: Vault;
  logger: Logger;
  now?: () => Date;
}

export class SpendResolution {
  readonly #db: Db;
  readonly #nodes: NodesService;
  readonly #auth: AuthService;
  readonly #vault: Vault;
  readonly #log: Logger;
  readonly #now: () => Date;

  constructor(options: ResolveOptions) {
    this.#db = options.db;
    this.#nodes = options.nodes;
    this.#auth = options.auth;
    this.#vault = options.vault;
    this.#log = options.logger.child('spend');
    this.#now = options.now ?? (() => new Date());
  }

  async list(nodeId: string) {
    const node = await this.#db.selectFrom('nodes').select('id').where('id', '=', nodeId).executeTakeFirst();
    if (!node) throw new AppError('not_found', 'No such node.');
    const rows = await this.#db
      .selectFrom('spend_intents')
      .selectAll()
      .where('node_id', '=', nodeId)
      .where('state', '=', 'unknown')
      .orderBy('created_at')
      .execute();
    return {
      items: rows.map((row) => ({
        intentId: row.id,
        type: row.type,
        amount: row.amount_msat,
        // Legacy rows have no immutable cost; they count as amount plus maximum fee (policy.ts).
        cost: row.cost_msat ?? (BigInt(row.amount_msat) + BigInt(row.max_fee_msat)).toString(),
        ...(row.destination === null ? {} : { destination: row.destination }),
        ...(row.payment_hash === null ? {} : { paymentHash: row.payment_hash }),
        ...(row.txid === null ? {} : { txid: row.txid }),
        ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
        ...(row.peer === null ? {} : { peer: row.peer }),
        reason: row.error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      warning: NOT_PAID_WARNING,
    };
  }

  async resolve(
    sessionHandle: string,
    nodeId: string,
    intentId: string,
    outcome: 'succeeded' | 'failed',
    requestId: string,
  ): Promise<{ intentId: string; state: 'succeeded' | 'failed' }> {
    const resolved = await writeTx(this.#db, async (trx) => {
      this.#auth.sessions.requireGrant(await liveSession(trx, this.#auth, sessionHandle), 'security');
      const intent = await trx
        .selectFrom('spend_intents')
        .selectAll()
        .where('id', '=', intentId)
        .where('node_id', '=', nodeId)
        .executeTakeFirst();
      if (!intent) throw new AppError('not_found', 'No such spend on this node.');
      if (intent.state !== 'unknown') throw new AppError('validation_failed', 'This spend is not unresolved.');
      await trx
        .updateTable('spend_intents')
        .set({
          state: outcome,
          error_code: OWNER_RESOLVED,
          psbt_key_id: null,
          psbt_nonce: null,
          psbt_ciphertext: null,
          updated_at: this.#now().toISOString(),
        })
        .where('id', '=', intentId)
        .where('state', '=', 'unknown')
        .execute();
      return intent;
    });
    this.#log.warn('spend resolved by owner', {
      requestId,
      intentId,
      sessionHandle,
      security: true,
      nodeId,
      type: resolved.type,
      state: outcome,
    });
    // An on-chain send the owner calls failed may still hold its inputs on the node; release them if it can.
    if (
      outcome === 'failed' &&
      resolved.type === 'onchain' &&
      resolved.txid !== null &&
      resolved.psbt_key_id !== null &&
      resolved.psbt_nonce !== null &&
      resolved.psbt_ciphertext !== null
    ) {
      const sealed = { key_id: resolved.psbt_key_id, nonce: resolved.psbt_nonce, ciphertext: resolved.psbt_ciphertext };
      await this.#release(nodeId, intentId, parseTxid(resolved.txid), sealed, requestId);
    }
    return { intentId, state: outcome };
  }

  // Runs after the owner's choice is stored, so nothing here may fail the request: a PSBT sealed under an old vault
  // key, or a node that cannot be asked, only leaves the inputs to the node's own reservation timeout.
  async #release(
    nodeId: string,
    intentId: string,
    txid: Txid,
    sealed: { key_id: string; nonce: Uint8Array; ciphertext: Uint8Array },
    requestId: string,
  ): Promise<void> {
    try {
      const psbt = this.#vault.openSecret(sealed, `intent_psbt:${intentId}`);
      const { canSpend } = await this.#nodes.adapter(nodeId);
      const adapter = canSpend
        ? await this.#nodes.spendingAdapter(nodeId)
        : (await this.#nodes.adapter(nodeId)).adapter;
      if (!canSpend) return;
      try {
        await adapter.onchain.discard(txid);
      } catch {
        await adapter.onchain.unreserve(psbt);
      }
    } catch (err) {
      // The node releases a reservation by itself after a while; the owner's choice stands.
      this.#log.warn('spend inputs not released', {
        requestId,
        intentId,
        code: err instanceof AdapterError || err instanceof AppError ? err.code : 'internal',
      });
    }
  }
}
