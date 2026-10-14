// Every payment is decoded independently and admitted atomically before any fund-moving RPC.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PROFILES } from '@lightning-pilot/chain';
import {
  AdapterError,
  AppError,
  DecodeError,
  decodeFailure,
  decodeRequest,
  msat,
  parseMsat,
  parsePaymentHash,
  toMsatString,
  type Chain,
  type ChainIdentityState,
  type PaymentHash,
  type Msat,
  type Network,
  type NodeAdapter,
  type SpendPolicy,
} from '@lightning-pilot/core';
import { writeTx, type Db } from '../../storage/db.ts';
import type { DB } from '../../storage/schema.ts';
import type { Logger } from '../../logging/logger.ts';
import { nodeDetail } from '../../logging/redact.ts';
import type { NodesService } from '../nodes/index.ts';
import type { AuthService } from '../auth/index.ts';
import {
  checkBudget,
  lightningFee,
  loadPolicy,
  policyValues,
  reserveSpend,
  spendCost,
  usedBudget,
  SPEND_SCOPE,
  type NodeIdentity,
} from './policy.ts';

const CONFIRMATION_TTL_MS = 120000;
const RETRY_FOR_SECONDS = 60;
const SETTLE_FAILED_AFTER_MS = (RETRY_FOR_SECONDS + 60) * 1000;
const BLOCKING = ['reserved', 'sent', 'unknown', 'succeeded'];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function blockedBy(state: string): AppError {
  return state === 'succeeded'
    ? new AppError('validation_failed', 'This invoice has already been paid from this node.')
    : new AppError('spend_unknown', 'An earlier payment of this invoice has no known outcome yet.');
}
function refuseUnlessConfirmed(identity: ChainIdentityState): void {
  if (identity.state === 'waiting') throw new AppError('chain_waiting', 'The node is not ready on its chain yet.');
  if (identity.state !== 'confirmed') throw new AppError('chain_refused', 'The node failed the chain identity check.');
}
interface PreviewPayload {
  bolt11: string;
  amountless: boolean;
  paymentHash: string;
  amount: string;
  maxFee: string;
  network: Network;
  invoiceExpiresAt: string;
  chain: string;
  pubkey: string;
  destination: string;
  cost: string;
  duplicates: string[];
}
interface Confirmation {
  sessionHandle: string;
  nodeId: string;
  digest: string;
  payload: PreviewPayload;
  expiresAt: number;
}
export type PreviewResult = import('zod').infer<typeof import('@lightning-pilot/core').PaymentPreviewResponse>;
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
  auth: AuthService;
  logger: Logger;
  now?: () => Date;
}
export class SpendService {
  readonly #db: Db;
  readonly #nodes: NodesService;
  readonly #auth: AuthService;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #unlisten: () => void;
  readonly #expiry: ReturnType<typeof setInterval>;
  readonly #confirmations = new Map<string, Confirmation>();
  constructor(options: SpendOptions) {
    this.#db = options.db;
    this.#nodes = options.nodes;
    this.#auth = options.auth;
    this.#log = options.logger.child('spend');
    this.#now = options.now ?? (() => new Date());
    this.#unlisten = this.#auth.sessions.onEnd((handle) => {
      for (const [key, confirmation] of this.#confirmations)
        if (confirmation.sessionHandle === handle) this.#confirmations.delete(key);
    });
    this.#expiry = setInterval(() => this.#prune(), 1000);
    this.#expiry.unref();
  }
  close(): void {
    clearInterval(this.#expiry);
    this.#unlisten();
    this.#confirmations.clear();
  }
  async #live(db: Db, handle: string) {
    const row = await db.selectFrom('sessions').selectAll().where('handle', '=', handle).executeTakeFirst();
    if (!row) throw new AppError('unauthenticated', 'Please log in.');
    const live = await this.#auth.sessions.live(db, row.id_hash);
    if (live.recovery_required === 1) throw new AppError('permission_denied', 'Complete authenticator recovery first.');
    return live;
  }
  async policy(nodeId: string) {
    const row = await this.#db.selectFrom('nodes').selectAll().where('id', '=', nodeId).executeTakeFirst();
    if (!row) throw new AppError('not_found', 'No such node.');
    const exists = await this.#db
      .selectFrom('spend_limits')
      .select('chain')
      .where('chain', '=', row.chain)
      .where('pubkey', '=', row.pubkey)
      .executeTakeFirst();
    const policy = exists ? await loadPolicy(this.#db, row) : null;
    const used = await usedBudget(this.#db, row, this.#now());
    return {
      policy,
      usedMsat: used.toString(),
      remainingMsat:
        policy?.max24h == null
          ? null
          : (BigInt(policy.max24h) * 1000n > used ? BigInt(policy.max24h) * 1000n - used : 0n).toString(),
      scope: SPEND_SCOPE,
    };
  }
  async updatePolicy(handle: string, nodeId: string, policy: SpendPolicy, requestId: string): Promise<void> {
    await writeTx(this.#db, async (db) => {
      this.#auth.sessions.requireGrant(await this.#live(db, handle), 'security');
      const node = await db.selectFrom('nodes').selectAll().where('id', '=', nodeId).executeTakeFirst();
      if (!node) throw new AppError('not_found', 'No such node.');
      const values = policyValues(policy);
      await db
        .insertInto('spend_limits')
        .values({ chain: node.chain, pubkey: node.pubkey, ...values })
        .onConflict((oc) => oc.columns(['chain', 'pubkey']).doUpdateSet(values))
        .execute();
    });
    this.#log.info('spend limits changed', { requestId, nodeId });
  }
  async #duplicates(db: Db, identity: NodeIdentity, destination: string, amount: string): Promise<string[]> {
    const rows = await db
      .selectFrom('spend_intents')
      .select('id')
      .where('chain', '=', identity.chain)
      .where('pubkey', '=', identity.pubkey)
      .where('destination', '=', destination)
      .where('amount_msat', '=', amount)
      .where('state', 'in', BLOCKING)
      .where('created_at', '>', new Date(this.#now().getTime() - 600000).toISOString())
      .where('created_at', '<=', this.#now().toISOString())
      .orderBy('id')
      .execute();
    return rows.map((row) => row.id);
  }
  #prune(): void {
    for (const [hash, confirmation] of this.#confirmations)
      if (confirmation.expiresAt <= this.#now().getTime()) this.#confirmations.delete(hash);
  }
  async preview(
    sessionHandle: string,
    nodeId: string,
    request: string,
    requestId: string,
    options: { amount?: string | undefined; maxFee?: string | undefined } = {},
  ): Promise<PreviewResult> {
    const { row, adapter, canSpend } = await this.#nodes.adapter(nodeId);
    if (!canSpend) throw new AppError('capability_missing', 'This node has no spend credential.');
    const identity = await this.#nodes.monitor.ensureFresh(nodeId);
    refuseUnlessConfirmed(identity);
    let decoded;
    try {
      decoded = decodeRequest(request, {
        network: row.network as Network,
        invoiceBit512: PROFILES[row.chain as Chain].invoiceBit512,
      });
    } catch (err) {
      if (err instanceof DecodeError) throw decodeFailure(err);
      throw err;
    }
    if (decoded.kind !== 'bolt11')
      throw decodeFailure(new DecodeError('unsupported', 'Only BOLT11 payments are supported here.'));
    const invoice = decoded.invoice;
    const amount = invoice.amount ?? (options.amount === undefined ? undefined : parseMsat(options.amount));
    if (
      amount === undefined ||
      amount === 0n ||
      (invoice.amount !== undefined && options.amount !== undefined && parseMsat(options.amount) !== invoice.amount)
    )
      throw new AppError('validation_failed', 'Enter a positive amount matching the invoice.');
    if (invoice.expiresAt.getTime() <= this.#now().getTime())
      throw new AppError('validation_failed', 'The invoice has expired.');
    await this.#guardInvoice(row, adapter, invoice.paymentHash, requestId);
    const policy = await loadPolicy(this.#db, row);
    const { fee, override } = lightningFee(amount, policy, options.maxFee);
    // The estimate is advisory; it can never widen the confirmed cap. No-route remains payable by xpay's own routing.
    const route = await adapter.pay.previewRoute({
      destination: invoice.payee,
      amount,
      maxFee: fee,
      finalCltv: invoice.minFinalCltvExpiryDelta,
    });
    if (route && (route.fee < 0n || route.fee > fee))
      throw new AppError('fee_cap_exceeded', 'The node route estimate exceeds the confirmed maximum fee.');
    const cost = spendCost({ type: 'bolt11', amount, maxFee: fee });
    const stepUp = checkBudget(policy, await usedBudget(this.#db, row, this.#now()), cost);
    const duplicates = await this.#duplicates(this.#db, row, invoice.payee, amount.toString());
    const payload: PreviewPayload = {
      bolt11: invoice.bolt11,
      amountless: invoice.amount === undefined,
      paymentHash: invoice.paymentHash,
      amount: amount.toString(),
      maxFee: fee.toString(),
      network: invoice.network,
      invoiceExpiresAt: invoice.expiresAt.toISOString(),
      chain: row.chain,
      pubkey: row.pubkey,
      destination: invoice.payee,
      cost: cost.toString(),
      duplicates,
    };
    const digest = sha256(JSON.stringify({ nodeId, ...payload }));
    await this.#live(this.#db, sessionHandle);
    this.#prune();
    if (this.#confirmations.size >= 1024) throw new AppError('busy', 'Too many pending payment previews.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(this.#now().getTime() + CONFIRMATION_TTL_MS, invoice.expiresAt.getTime());
    this.#confirmations.set(sha256(token), { sessionHandle, nodeId, digest, payload, expiresAt });
    this.#log.info('payment preview', {
      requestId,
      nodeId,
      paymentHash: invoice.paymentHash,
      amountMsat: payload.amount,
    });
    return {
      confirmationToken: token,
      decoded: {
        kind: 'bolt11',
        network: invoice.network,
        paymentHash: invoice.paymentHash,
        amount: payload.amount,
        expiresAt: payload.invoiceExpiresAt,
      },
      cost: { amount: payload.amount, maxFee: payload.maxFee, total: payload.cost },
      chainIdentity: identity,
      expiresAt: new Date(expiresAt).toISOString(),
      payee: invoice.payee,
      description: invoice.description ?? '',
      duplicateWarning: duplicates.length > 0,
      stepUpRequired: stepUp || override,
      feeOverride: override,
      scope: SPEND_SCOPE,
    };
  }
  #replay(
    intent: import('kysely').Selectable<DB['spend_intents']>,
    handle: string,
    nodeId: string,
    hash: string,
  ): ExecuteResult {
    if (intent.session_handle !== handle || intent.confirmation_hash !== hash || intent.node_id !== nodeId)
      throw new AppError('idempotency_conflict', 'This idempotency key was used for another request.');
    if (intent.state === 'reserved' || intent.state === 'sent')
      throw new AppError('idempotency_conflict', 'This payment is still running.');
    return this.#result(
      intent.id,
      intent.state as ExecuteResult['state'],
      intent.payment_hash,
      intent.amount_msat,
      intent.fee_msat,
    );
  }
  async execute(
    sessionHandle: string,
    nodeId: string,
    token: string,
    idempotencyKey: string,
    requestId: string,
    acknowledgeDuplicate = false,
  ): Promise<ExecuteResult> {
    const tokenHash = sha256(token);
    await this.#live(this.#db, sessionHandle);
    const retried = await this.#db
      .selectFrom('spend_intents')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (retried) return this.#replay(retried, sessionHandle, nodeId, tokenHash);
    this.#prune();
    const confirmation = this.#confirmations.get(tokenHash);
    if (!confirmation || confirmation.sessionHandle !== sessionHandle || confirmation.nodeId !== nodeId)
      throw new AppError('confirmation_invalid', 'The confirmation is missing, used, expired or not yours.');
    const payload = confirmation.payload;
    const { row, adapter, canSpend } = await this.#nodes.adapter(nodeId);
    if (!canSpend) throw new AppError('capability_missing', 'This node has no spend credential.');
    await this.#nodes.monitor.ensureChecked(nodeId);
    refuseUnlessConfirmed(this.#nodes.identity(row));
    await this.#guardInvoice(row, adapter, parsePaymentHash(payload.paymentHash), requestId, false);
    const claim = async (trx: Db, policy: SpendPolicy, stepUp: boolean) => {
      const live = await this.#live(trx, sessionHandle);
      const node = await trx.selectFrom('nodes').selectAll().where('id', '=', nodeId).executeTakeFirstOrThrow();
      refuseUnlessConfirmed(this.#nodes.identity(node));
      if (
        node.chain !== payload.chain ||
        node.pubkey !== payload.pubkey ||
        this.#confirmations.get(tokenHash) !== confirmation ||
        confirmation.expiresAt <= this.#now().getTime()
      )
        throw new AppError('confirmation_invalid', 'The confirmation is missing, used, expired or not yours.');
      const earlier = await trx
        .selectFrom('spend_intents')
        .select('state')
        .where('chain', '=', node.chain)
        .where('pubkey', '=', node.pubkey)
        .where('payment_hash', '=', payload.paymentHash)
        .where('state', 'in', BLOCKING)
        .executeTakeFirst();
      if (earlier) throw blockedBy(earlier.state);
      const duplicates = await this.#duplicates(trx, node, payload.destination, payload.amount);
      if (
        duplicates.some((id) => !payload.duplicates.includes(id)) ||
        (payload.duplicates.length > 0 && !acknowledgeDuplicate)
      )
        throw new AppError(
          'confirmation_invalid',
          'Review and acknowledge the duplicate-payment warning in a fresh preview.',
          { reason: 'duplicate_payment' },
        );
      const fee = lightningFee(parseMsat(payload.amount), policy, payload.maxFee);
      if (stepUp || fee.override) this.#auth.sessions.requireGrant(live, 'password');
      const intentId = randomUUID();
      await trx
        .insertInto('spend_intents')
        .values({
          id: intentId,
          node_id: nodeId,
          chain: node.chain,
          pubkey: node.pubkey,
          type: 'bolt11',
          payment_hash: payload.paymentHash,
          amount_msat: payload.amount,
          max_fee_msat: payload.maxFee,
          cost_msat: payload.cost,
          destination: payload.destination,
          session_handle: sessionHandle,
          confirmation_hash: tokenHash,
          fee_msat: null,
          state: 'reserved',
          idempotency_key: idempotencyKey,
          digest: confirmation.digest,
          error_code: null,
          created_at: this.#now().toISOString(),
          updated_at: this.#now().toISOString(),
        })
        .execute();
      return { intentId };
    };
    // Same-key races check replay inside the transaction before checking a newly changed policy/budget.
    const replay = async (trx: Db) => {
      await this.#live(trx, sessionHandle);
      const existing = await trx
        .selectFrom('spend_intents')
        .selectAll()
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (existing) return { replay: this.#replay(existing, sessionHandle, nodeId, tokenHash) };
      return undefined;
    };
    const claimed = await this.#nodes.monitor.admit(nodeId, () =>
      reserveSpend<{ intentId: string } | { replay: ExecuteResult }>(
        this.#db,
        row,
        parseMsat(payload.cost),
        this.#now,
        claim,
        replay,
      ),
    );
    if ('replay' in claimed) return claimed.replay;
    this.#confirmations.delete(tokenHash);
    const { intentId } = claimed;
    const paymentHash = parsePaymentHash(payload.paymentHash);
    let state: ExecuteResult['state'];
    let fee: Msat | undefined;
    let preimage: string | undefined;
    let errorCode: string | null = null;
    let paidAmount: Msat | undefined;
    let nodeCallStarted = false;
    try {
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
      nodeCallStarted = true;
      const paid = await adapter.pay.pay({
        bolt11: payload.bolt11,
        ...(payload.amountless ? { amount: parseMsat(payload.amount) } : {}),
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
      const definite = !nodeCallStarted || (err instanceof AdapterError && (!err.sent || err.definitive));
      state = definite ? 'failed' : 'unknown';
      errorCode = err instanceof AdapterError ? err.code : 'internal';
      // An audit-sink failure must not prevent persisting whether funds may have moved.
      try {
        this.#log.warn('payment not completed', {
          requestId,
          intentId,
          state,
          code: errorCode,
          nodeCode: err instanceof AdapterError ? err.nodeCode : undefined,
          detail: err instanceof AdapterError ? nodeDetail(err.detail) : undefined,
        });
      } catch {
        /* The database result remains authoritative. */
      }
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
    try {
      this.#log.info('spend result', {
        requestId,
        intentId,
        nodeId,
        paymentHash,
        state,
        feeMsat: fee === undefined ? undefined : toMsatString(fee),
        code: errorCode ?? undefined,
      });
    } catch {
      /* A failed log sink must not replace the durable outcome. */
    }

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
  async #guardInvoice(
    identity: NodeIdentity,
    adapter: NodeAdapter,
    paymentHash: PaymentHash,
    requestId: string,
    refuse = true,
  ) {
    const earlier = await this.#db
      .selectFrom('spend_intents')
      .select(['id', 'state', 'amount_msat', 'updated_at'])
      .where('chain', '=', identity.chain)
      .where('pubkey', '=', identity.pubkey)
      .where('payment_hash', '=', paymentHash)
      .where('state', 'in', BLOCKING)
      .execute();
    for (const intent of earlier) {
      const state =
        intent.state === 'unknown' ? await this.#settle(intent, adapter, paymentHash, requestId) : intent.state;
      if (refuse && state !== 'failed') throw blockedBy(state);
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
