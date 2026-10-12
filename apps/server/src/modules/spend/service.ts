// Spending (minimal): BOLT11 payments through the two-step flow every spend follows.
//   preview  decode the invoice ourselves, check network, amount, expiry and the node's chain identity, compute the
//            cost, and return it with a single-use confirmation token (2 minutes, bound to this session);
//   execute  in one write transaction: claim the idempotency key, use up the token, store the intent ("reserved");
//            then call the node with the intent id as label; then store the outcome.
// An outcome is `failed` only if nothing was sent or the node definitively said nothing was paid; everything else
// is `unknown` and blocks further spends on the node until resolved. Payments are never retried automatically.
// Limits, step-up, fee caps and crash recovery come in later work packages.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AdapterError,
  add,
  AppError,
  Bolt11Error,
  max,
  msat,
  parseMsat,
  parsePaymentHash,
  ppm,
  readBolt11,
  toMsatString,
  type ChainIdentityState,
  type Msat,
  type Network,
} from '@lightning-pilot/core';
import { writeTx, type Db } from '../../storage/db.ts';
import type { Logger } from '../../logging/logger.ts';
import { nodeDetail } from '../../logging/redact.ts';
import type { NodesService } from '../nodes/index.ts';

const CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const RETRY_FOR_SECONDS = 60;
// Default fee cap until owner-set caps exist: 0.5 % of the amount, at least 5 sat (CLN's own defaults for `pay`).
const FEE_PPM = 5_000n;
const FEE_MINIMUM = 5_000n;
const UNRESOLVED = ['reserved', 'sent', 'unknown'];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

interface PreviewPayload {
  bolt11: string;
  paymentHash: string;
  amount: string;
  maxFee: string;
  network: Network;
  invoiceExpiresAt: string;
}

export interface PreviewResult {
  confirmationToken: string;
  decoded: { kind: 'bolt11'; network: Network; paymentHash: string; amount: string; expiresAt: string };
  cost: { amount: string; maxFee: string; total: string };
  chainIdentity: ChainIdentityState;
  expiresAt: string;
}

export interface ExecuteResult {
  intentId: string;
  state: 'succeeded' | 'failed' | 'unknown';
  paymentHash: string;
  amount: string;
  fee?: string;
  preimage?: string;
}

export interface SpendOptions {
  db: Db;
  nodes: NodesService;
  logger: Logger;
  now?: () => Date;
}

export class SpendService {
  readonly #db: Db;
  readonly #nodes: NodesService;
  readonly #log: Logger;
  readonly #now: () => Date;

  constructor(options: SpendOptions) {
    this.#db = options.db;
    this.#nodes = options.nodes;
    this.#log = options.logger.child('spend');
    this.#now = options.now ?? (() => new Date());
  }

  async preview(sessionHandle: string, nodeId: string, request: string, requestId: string): Promise<PreviewResult> {
    const { row, adapter, canSpend } = await this.#nodes.adapter(nodeId);
    if (!canSpend) throw new AppError('capability_missing', 'This node has no spend credential.');
    const identity = this.#nodes.identity(row);
    if (identity.state === 'waiting') throw new AppError('chain_waiting', 'The node is not ready on its chain yet.');
    if (identity.state !== 'confirmed')
      throw new AppError('chain_refused', 'The node failed the chain identity check.');

    let decoded;
    try {
      decoded = readBolt11(request);
    } catch (err) {
      throw new AppError(
        'validation_failed',
        err instanceof Bolt11Error ? `Not a payable invoice: ${err.message}.` : 'Not a payable invoice.',
      );
    }
    if (decoded.network !== row.network) {
      throw new AppError('validation_failed', `The invoice is for ${decoded.network}, the node is on ${row.network}.`);
    }
    if (decoded.amount === undefined) {
      throw new AppError('validation_failed', 'Invoices without an amount are not supported yet.');
    }
    if (decoded.amount === 0n) throw new AppError('validation_failed', 'The invoice amount is zero.');
    if (decoded.expiresAt.getTime() <= this.#now().getTime()) {
      throw new AppError('validation_failed', 'The invoice has expired.');
    }

    // The node must still be the one whose identity was checked: same public key, same network.
    const facts = await adapter.node.getInfo();
    if (facts.pubkey !== row.pubkey || facts.network !== row.network) {
      throw new AppError('chain_refused', 'The node is not the one that was checked.');
    }

    const amount = decoded.amount;
    const maxFee = max(msat(FEE_MINIMUM), ppm(amount, FEE_PPM));
    const payload: PreviewPayload = {
      bolt11: request.trim(),
      paymentHash: decoded.paymentHash,
      amount: toMsatString(amount),
      maxFee: toMsatString(maxFee),
      network: decoded.network,
      invoiceExpiresAt: decoded.expiresAt.toISOString(),
    };
    const digest = sha256(JSON.stringify({ nodeId, ...payload }));
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.#now().getTime() + CONFIRMATION_TTL_MS).toISOString();
    await this.#db
      .insertInto('spend_confirmations')
      .values({
        token_hash: sha256(token),
        session_handle: sessionHandle,
        node_id: nodeId,
        digest,
        payload: JSON.stringify(payload),
        expires_at: expiresAt,
        used_at: null,
      })
      .execute();
    this.#log.info('payment preview', {
      requestId,
      nodeId,
      paymentHash: decoded.paymentHash,
      amountMsat: payload.amount,
    });
    return {
      confirmationToken: token,
      decoded: {
        kind: 'bolt11',
        network: decoded.network,
        paymentHash: decoded.paymentHash,
        amount: payload.amount,
        expiresAt: payload.invoiceExpiresAt,
      },
      cost: { amount: payload.amount, maxFee: payload.maxFee, total: toMsatString(add(amount, maxFee)) },
      chainIdentity: identity,
      expiresAt,
    };
  }

  async execute(
    sessionHandle: string,
    nodeId: string,
    token: string,
    idempotencyKey: string,
    requestId: string,
  ): Promise<ExecuteResult> {
    const { row, adapter } = await this.#nodes.adapter(nodeId);
    const tokenHash = sha256(token);
    const now = this.#now();

    const claimed = await writeTx(this.#db, async (trx) => {
      const confirmation = await trx
        .selectFrom('spend_confirmations')
        .selectAll()
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst();

      // A retry with the same key returns what happened the first time; the key reused for anything else is refused.
      const existing = await trx
        .selectFrom('spend_intents')
        .selectAll()
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        const same =
          confirmation !== undefined && existing.digest === confirmation.digest && existing.node_id === nodeId;
        if (!same) throw new AppError('idempotency_conflict', 'This idempotency key was used for another request.');
        return { replay: existing } as const;
      }

      const valid =
        confirmation !== undefined &&
        confirmation.session_handle === sessionHandle &&
        confirmation.node_id === nodeId &&
        confirmation.used_at === null &&
        Date.parse(confirmation.expires_at) > now.getTime();
      if (!valid)
        throw new AppError('confirmation_invalid', 'The confirmation is missing, used, expired or not yours.');
      await trx
        .updateTable('spend_confirmations')
        .set({ used_at: now.toISOString() })
        .where('token_hash', '=', tokenHash)
        .execute();

      const unresolved = await trx
        .selectFrom('spend_intents')
        .select('id')
        .where('node_id', '=', nodeId)
        .where('state', 'in', UNRESOLVED)
        .executeTakeFirst();
      if (unresolved) throw new AppError('spend_unknown', 'An earlier payment on this node is still unresolved.');

      const payload = JSON.parse(confirmation.payload) as PreviewPayload;
      const intentId = randomUUID();
      await trx
        .insertInto('spend_intents')
        .values({
          id: intentId,
          node_id: nodeId,
          chain: row.chain,
          pubkey: row.pubkey,
          type: 'bolt11',
          payment_hash: payload.paymentHash,
          amount_msat: payload.amount,
          max_fee_msat: payload.maxFee,
          fee_msat: null,
          state: 'reserved',
          idempotency_key: idempotencyKey,
          digest: confirmation.digest,
          error_code: null,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .execute();
      return { intentId, payload } as const;
    });

    if ('replay' in claimed) {
      const intent = claimed.replay;
      if (intent.state === 'reserved' || intent.state === 'sent') {
        throw new AppError('idempotency_conflict', 'This payment is still running.');
      }
      return this.#result(
        intent.id,
        intent.state as ExecuteResult['state'],
        intent.payment_hash,
        intent.amount_msat,
        intent.fee_msat,
      );
    }

    const { intentId, payload } = claimed;
    const paymentHash = parsePaymentHash(payload.paymentHash);
    this.#log.info('spend intent', {
      requestId,
      intentId,
      nodeId,
      chain: row.chain,
      type: 'bolt11',
      paymentHash,
      amountMsat: payload.amount,
      maxFeeMsat: payload.maxFee,
    });

    let state: ExecuteResult['state'];
    let fee: Msat | undefined;
    let preimage: string | undefined;
    let errorCode: string | null = null;
    try {
      const paid = await adapter.pay.pay({
        bolt11: payload.bolt11,
        maxFee: parseMsat(payload.maxFee),
        label: intentId,
        retryForSeconds: RETRY_FOR_SECONDS,
      });
      if (paid.paymentHash !== paymentHash) {
        // The node paid something other than what was confirmed: record it, never call it a success.
        state = 'unknown';
        errorCode = 'node_bad_response';
      } else {
        state = 'succeeded';
        fee = paid.fee;
        preimage = paid.preimage;
      }
    } catch (err) {
      const definite = err instanceof AdapterError && (!err.sent || err.definitive);
      state = definite ? 'failed' : 'unknown';
      errorCode = err instanceof AdapterError ? err.code : 'internal';
      this.#log.warn('payment not completed', {
        requestId,
        intentId,
        state,
        code: errorCode,
        nodeCode: err instanceof AdapterError ? err.nodeCode : undefined,
        detail: err instanceof AdapterError ? nodeDetail(err.detail) : undefined,
      });
    }

    await this.#db
      .updateTable('spend_intents')
      .set({
        state,
        fee_msat: fee === undefined ? null : toMsatString(fee),
        error_code: errorCode,
        updated_at: this.#now().toISOString(),
      })
      .where('id', '=', intentId)
      .execute();
    this.#log.info('spend result', {
      requestId,
      intentId,
      nodeId,
      paymentHash,
      state,
      feeMsat: fee === undefined ? undefined : toMsatString(fee),
      code: errorCode ?? undefined,
    });

    if (state === 'failed') {
      throw new AppError('payment_failed', 'The payment failed; nothing was paid.', { intentId, reason: errorCode });
    }
    return this.#result(
      intentId,
      state,
      paymentHash,
      payload.amount,
      fee === undefined ? null : toMsatString(fee),
      preimage,
    );
  }

  #result(
    intentId: string,
    state: ExecuteResult['state'],
    paymentHash: string,
    amount: string,
    fee: string | null,
    preimage?: string,
  ): ExecuteResult {
    if (state === 'failed') {
      throw new AppError('payment_failed', 'The payment failed; nothing was paid.', { intentId });
    }
    return {
      intentId,
      state,
      paymentHash,
      amount,
      ...(fee === null ? {} : { fee }),
      ...(preimage === undefined ? {} : { preimage }),
    };
  }
}
