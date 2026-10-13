// Spending (minimal): BOLT11 payments through the two-step flow every spend follows.
//   preview  decode the invoice ourselves, check network, amount, expiry and the node's chain identity, compute the
//            cost, and return it with a single-use confirmation token (2 minutes, bound to this session);
//   execute  in one write transaction: claim the idempotency key, use up the token, store the intent ("reserved");
//            then call the node with the intent id as label; then store the outcome.
// An outcome is `failed` only if nothing was sent or the node definitively said nothing was paid; everything else
// is `unknown`. An invoice with an unresolved or successful payment on the node cannot be paid again from it; other
// invoices are not affected. An `unknown` payment is checked with the node (read-only) the next time its invoice is
// previewed or paid. Payments are never retried automatically.
// Limits, step-up, fee caps and crash recovery at start-up come in later work packages.
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
  type PaymentHash,
  type Msat,
  type Network,
  type NodeAdapter,
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
// States that stop the same invoice from being paid again from the same node.
const BLOCKING = [...UNRESOLVED, 'succeeded'];
// An `unknown` payment is declared failed from the node's records only once xpay has stopped retrying it (retry_for)
// plus a margin: until then the node may still start another attempt.
const SETTLE_FAILED_AFTER_MS = (RETRY_FOR_SECONDS + 60) * 1000;

function blockedBy(state: string): AppError {
  return state === 'succeeded'
    ? new AppError('validation_failed', 'This invoice has already been paid from this node.')
    : new AppError('spend_unknown', 'An earlier payment of this invoice has no known outcome yet.');
}

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
      // readBolt11 throws only Bolt11Error, whose messages are fixed text (no input echoed).
      throw new AppError('validation_failed', `Not a payable invoice: ${(err as Bolt11Error).message}.`);
    }
    if (decoded.network !== row.network) {
      throw new AppError('validation_failed', `The invoice is for ${decoded.network}, the node is on ${row.network}.`);
    }
    if (decoded.amount === undefined) {
      throw new AppError('validation_failed', 'Invoices without an amount are not supported yet.');
    }
    if (decoded.expiresAt.getTime() <= this.#now().getTime()) {
      throw new AppError('validation_failed', 'The invoice has expired.');
    }

    // The node must still be the one whose identity was checked: same public key, same network.
    const facts = await adapter.node.getInfo();
    if (facts.pubkey !== row.pubkey || facts.network !== row.network) {
      throw new AppError('chain_refused', 'The node is not the one that was checked.');
    }

    await this.#guardInvoice(nodeId, adapter, decoded.paymentHash, requestId);

    const amount = decoded.amount;
    const maxFee = max(msat(FEE_MINIMUM), ppm(amount, FEE_PPM));
    const payload: PreviewPayload = {
      // The normalised text: nodes refuse some spellings our reader accepts (`Lightning:` in mixed case).
      bolt11: decoded.bolt11,
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

    // Before the write transaction (no node call may hold the write lock): settle what the node can tell about earlier
    // payments of this invoice. Only for a usable confirmation, and not for a retry with a known key (which only returns
    // the first result): the transaction below gives those their own answers.
    const pending = await this.#db
      .selectFrom('spend_confirmations')
      .select('payload')
      .where('token_hash', '=', tokenHash)
      .where('session_handle', '=', sessionHandle)
      .where('node_id', '=', nodeId)
      .where('used_at', 'is', null)
      .where('expires_at', '>', this.#now().toISOString())
      .executeTakeFirst();
    const retried = await this.#db
      .selectFrom('spend_intents')
      .select('id')
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (pending && !retried) {
      const { paymentHash } = JSON.parse(pending.payload) as PreviewPayload;
      await this.#guardInvoice(nodeId, adapter, parsePaymentHash(paymentHash), requestId);
    }

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

      const payload = JSON.parse(confirmation.payload) as PreviewPayload;
      // Checked again inside the transaction: another request may have started paying this invoice meanwhile.
      const earlier = await trx
        .selectFrom('spend_intents')
        .select('state')
        .where('node_id', '=', nodeId)
        .where('payment_hash', '=', payload.paymentHash)
        .where('state', 'in', BLOCKING)
        .executeTakeFirst();
      if (earlier) throw blockedBy(earlier.state);

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
    let paidAmount: Msat | undefined;
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
        // The preimage proves the payment, so it succeeded; but if the node paid another amount, or more fee than the
        // cap, than was confirmed, the node's own figures are stored and the mismatch is flagged.
        state = 'succeeded';
        fee = paid.fee;
        preimage = paid.preimage;
        if (paid.amount !== parseMsat(payload.amount) || paid.fee > parseMsat(payload.maxFee)) {
          errorCode = 'amount_mismatch';
          paidAmount = paid.amount;
          this.#log.error('node paid other figures than confirmed', {
            requestId,
            intentId,
            nodeId,
            paymentHash,
            confirmedAmountMsat: payload.amount,
            paidAmountMsat: toMsatString(paid.amount),
            maxFeeMsat: payload.maxFee,
            feeMsat: toMsatString(paid.fee),
          });
        }
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
        ...(paidAmount === undefined ? {} : { amount_msat: toMsatString(paidAmount) }),
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
      paidAmount === undefined ? payload.amount : toMsatString(paidAmount),
      fee === undefined ? null : toMsatString(fee),
      preimage,
    );
  }

  // The same invoice is never paid twice from one node. Earlier payments of it are looked at: an `unknown` one is
  // checked with the node first; one that succeeded or is still unresolved refuses the new spend.
  async #guardInvoice(nodeId: string, adapter: NodeAdapter, paymentHash: PaymentHash, requestId: string) {
    const earlier = await this.#db
      .selectFrom('spend_intents')
      .select(['id', 'state', 'amount_msat', 'updated_at'])
      .where('node_id', '=', nodeId)
      .where('payment_hash', '=', paymentHash)
      .where('state', 'in', BLOCKING)
      .execute();
    for (const intent of earlier) {
      const state =
        intent.state === 'unknown' ? await this.#settle(intent, adapter, paymentHash, requestId) : intent.state;
      if (state !== 'failed') throw blockedBy(state);
    }
  }

  // Reads the node's record of an `unknown` payment and stores the outcome when the record is clear: complete →
  // succeeded; every part failed (and xpay has stopped retrying) → failed. Anything else stays unknown. `reserved`
  // and `sent` are never settled here: in a running server they mean the node call is still in progress.
  async #settle(
    intent: { id: string; amount_msat: string; updated_at: string },
    adapter: NodeAdapter,
    paymentHash: PaymentHash,
    requestId: string,
  ): Promise<string> {
    let record;
    try {
      record = await adapter.pay.getPayment(paymentHash);
    } catch (err) {
      this.#log.warn('payment status not readable', {
        requestId,
        intentId: intent.id,
        code: err instanceof AdapterError ? err.code : 'internal',
      });
      return 'unknown';
    }
    const now = this.#now();
    let state: 'succeeded' | 'failed' | undefined;
    let fee: Msat | undefined;
    if (record?.status === 'succeeded') {
      state = 'succeeded';
      const amount = parseMsat(intent.amount_msat);
      if (record.amountSent !== undefined && record.amountSent >= amount) fee = msat(record.amountSent - amount);
    } else if (record?.status === 'failed' && now.getTime() - Date.parse(intent.updated_at) >= SETTLE_FAILED_AFTER_MS) {
      state = 'failed';
    }
    if (state === undefined) return 'unknown';
    await this.#db
      .updateTable('spend_intents')
      .set({
        state,
        ...(fee === undefined ? {} : { fee_msat: toMsatString(fee) }),
        updated_at: now.toISOString(),
      })
      .where('id', '=', intent.id)
      .where('state', '=', 'unknown')
      .execute();
    this.#log.info('spend settled', {
      requestId,
      intentId: intent.id,
      paymentHash,
      state,
      ...(fee === undefined ? {} : { feeMsat: toMsatString(fee) }),
    });
    return state;
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
