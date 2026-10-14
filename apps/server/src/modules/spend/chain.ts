// On-chain sends, channel opens and channel closes (WP09b), and the peer connections a channel needs. Same protocol
// as a payment (spend policy §3, §10): a preview computes the cost and issues a single-use confirmation token; the
// execute call admits the intent atomically (limits, rolling window, step-up, idempotency key) before any
// fund-moving node call, and stores the outcome. Crash recovery of these types is not built yet: an intent left
// `reserved` becomes `unknown` at the next start and stays counted against the limits.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AdapterError,
  AppError,
  DecodeError,
  decodeAddress,
  decodeFailure,
  parseChannelId,
  parseMsat,
  parsePubkey,
  parseShortChannelId,
  parseTxid,
  PsbtError,
  readPsbt,
  toMsatString,
  ZERO,
  type Channel,
  type ChainIdentityState,
  type Msat,
  type Network,
  type NodeAdapter,
  type SpendPolicy,
  type Txid,
} from '@lightning-pilot/core';
import type { Db } from '../../storage/db.ts';
import type { Logger } from '../../logging/logger.ts';
import { nodeDetail } from '../../logging/redact.ts';
import type { AuthService } from '../auth/index.ts';
import type { NodesService } from '../nodes/index.ts';
import type { Vault } from '../vault/index.ts';
import {
  CONFIRMATION_TTL_MS,
  duplicatesOf,
  liveSession,
  MAX_LIVE_CONFIRMATIONS,
  refuseUnlessConfirmed,
  sha256,
} from './common.ts';
import {
  checkBudget,
  loadPolicy,
  onchainFee,
  operationNeedsStepUp,
  reserveSpend,
  spendCost,
  usedBudget,
  SPEND_SCOPE,
  type SpendOperation,
} from './policy.ts';

export type ChainSpendKind = 'onchain' | 'channel-open' | 'channel-close';

interface Base {
  chain: string;
  pubkey: string;
  amount: string;
  maxFee: string;
  cost: string;
  // What the duplicate warning compares (address, peer, or the channel for a close to the node's own wallet).
  destination: string;
  duplicates: string[];
}
type Payload =
  | (Base & { type: 'onchain'; address: string; script: string; feeRate: string; stepUp: boolean })
  | (Base & { type: 'channel-open'; peer: string; push: string; feeRate: string; announce?: boolean; stepUp: boolean })
  | (Base & {
      type: 'channel-close';
      channelId: string;
      channelRef: string;
      peer: string;
      force: boolean;
      external: boolean;
      closeTo?: string;
    });

interface Confirmation {
  sessionHandle: string;
  nodeId: string;
  digest: string;
  payload: Payload;
  expiresAt: number;
}

export interface SpendOutcome {
  intentId: string;
  state: 'succeeded' | 'failed' | 'unknown';
  txid?: string;
  channelId?: string;
  closeType?: 'mutual' | 'unilateral' | 'unopened' | 'pending';
}

interface PreviewCommon {
  confirmationToken: string;
  cost: { amount: string; maxFee: string; total: string };
  duplicateWarning: boolean;
  stepUpRequired: boolean;
  feeOverride: boolean;
  scope: string;
  chainIdentity: ChainIdentityState;
  expiresAt: string;
}

export interface ChainSpendOptions {
  db: Db;
  nodes: NodesService;
  auth: AuthService;
  vault: Vault;
  logger: Logger;
  now?: () => Date;
}

// The node's own estimate for the next blocks, normalised to at most three decimals (rounded up).
export function rateOf(value: string): string {
  const match = /^([0-9]{1,7})(?:\.([0-9]+))?$/.exec(value);
  if (!match) throw new AppError('fee_cap_exceeded', 'Invalid node fee estimate.');
  const whole = BigInt(match[1] as string);
  const digits = match[2] ?? '';
  let thousandths = whole * 1000n + BigInt(digits.slice(0, 3).padEnd(3, '0'));
  if (/[1-9]/.test(digits.slice(3))) thousandths += 1n;
  if (thousandths === 0n || thousandths >= 10_000_000_000n)
    throw new AppError('fee_cap_exceeded', 'Invalid node fee estimate.');
  const fraction = (thousandths % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${thousandths / 1000n}.${fraction}` : `${thousandths / 1000n}`;
}

// The on-chain fee is not known before the node selects coins, so the confirmed maximum is the owner's fee share of
// the amount; the rate is checked against `maxFeeRate`. The node's actual fee is checked against this maximum
// before anything is broadcast (on-chain send) or cannot exceed it at the confirmed rate in practice (channel open).
function onchainMaxFee(amount: Msat, policy: SpendPolicy): Msat {
  return parseMsat(((amount * BigInt(policy.maxFeeSharePercent)) / 100n).toString());
}

export class ChainSpends {
  readonly #db: Db;
  readonly #nodes: NodesService;
  readonly #auth: AuthService;
  readonly #vault: Vault;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #confirmations = new Map<string, Confirmation>();
  readonly #unlisten: () => void;
  readonly #expiry: ReturnType<typeof setInterval>;

  constructor(options: ChainSpendOptions) {
    this.#db = options.db;
    this.#nodes = options.nodes;
    this.#auth = options.auth;
    this.#vault = options.vault;
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

  #prune(): void {
    for (const [hash, confirmation] of this.#confirmations)
      if (confirmation.expiresAt <= this.#now().getTime()) this.#confirmations.delete(hash);
  }

  async #spendingNode(nodeId: string) {
    const { row, adapter, canSpend } = await this.#nodes.adapter(nodeId);
    if (!canSpend) throw new AppError('capability_missing', 'This node has no spend credential.');
    const identity = await this.#nodes.monitor.ensureFresh(nodeId);
    refuseUnlessConfirmed(identity);
    return { row, adapter, identity };
  }

  async #issue(
    sessionHandle: string,
    nodeId: string,
    payload: Payload,
    identity: ChainIdentityState,
    feeOverride: boolean,
    stepUp: boolean,
  ): Promise<PreviewCommon> {
    await liveSession(this.#db, this.#auth, sessionHandle);
    this.#prune();
    if (this.#confirmations.size >= MAX_LIVE_CONFIRMATIONS)
      throw new AppError('busy', 'Too many pending spend previews.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.#now().getTime() + CONFIRMATION_TTL_MS;
    const digest = sha256(JSON.stringify({ nodeId, ...payload }));
    this.#confirmations.set(sha256(token), { sessionHandle, nodeId, digest, payload, expiresAt });
    return {
      confirmationToken: token,
      cost: { amount: payload.amount, maxFee: payload.maxFee, total: payload.cost },
      duplicateWarning: payload.duplicates.length > 0,
      stepUpRequired: stepUp || feeOverride,
      feeOverride,
      scope: SPEND_SCOPE,
      chainIdentity: identity,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async #feeRate(adapter: NodeAdapter, requested: string | undefined, opening: boolean): Promise<string> {
    if (requested !== undefined) return rateOf(requested);
    const estimates = await adapter.chain.getFeeEstimates();
    return rateOf((opening ? estimates.node?.opening : undefined) ?? estimates.rates.halfHour);
  }

  #address(text: string, network: Network) {
    try {
      return decodeAddress(text, network);
    } catch (err) {
      if (err instanceof DecodeError) throw decodeFailure(err);
      throw err;
    }
  }

  async previewOnchain(
    sessionHandle: string,
    nodeId: string,
    request: { address: string; amount: string; feeRate?: string | undefined },
    requestId: string,
  ) {
    const { row, adapter, identity } = await this.#spendingNode(nodeId);
    const address = this.#address(request.address, row.network as Network);
    const amount = parseMsat(request.amount);
    const policy = await loadPolicy(this.#db, row);
    const feeRate = await this.#feeRate(adapter, request.feeRate, false);
    const maxFee = onchainMaxFee(amount, policy);
    const feeOverride = onchainFee(amount, maxFee, feeRate, policy);
    const cost = spendCost({ type: 'onchain', amount, maxFee });
    const stepUp = checkBudget(policy, await usedBudget(this.#db, row, this.#now()), cost);
    const payload: Payload = {
      type: 'onchain',
      chain: row.chain,
      pubkey: row.pubkey,
      address: address.address,
      script: address.script,
      feeRate,
      amount: amount.toString(),
      maxFee: maxFee.toString(),
      cost: cost.toString(),
      destination: address.address,
      duplicates: await duplicatesOf(this.#db, row, address.address, amount.toString(), this.#now()),
      stepUp: stepUp || feeOverride,
    };
    const common = await this.#issue(sessionHandle, nodeId, payload, identity, feeOverride, stepUp);
    this.#log.info('spend preview', { requestId, nodeId, type: 'onchain', amountMsat: payload.amount });
    return { ...common, address: address.address, addressType: address.type, amount: payload.amount, feeRate };
  }

  async previewChannelOpen(
    sessionHandle: string,
    nodeId: string,
    request: {
      peer: string;
      amount: string;
      push?: string | undefined;
      feeRate?: string | undefined;
      announce?: boolean | undefined;
    },
    requestId: string,
  ) {
    const { row, adapter, identity } = await this.#spendingNode(nodeId);
    const peer = parsePubkey(request.peer);
    if (peer === row.pubkey) throw new AppError('validation_failed', 'A node cannot open a channel to itself.');
    const amount = parseMsat(request.amount);
    const push = request.push === undefined ? ZERO : parseMsat(request.push);
    if (push > amount) throw new AppError('validation_failed', 'The push amount exceeds the channel amount.');
    const policy = await loadPolicy(this.#db, row);
    const feeRate = await this.#feeRate(adapter, request.feeRate, true);
    const maxFee = onchainMaxFee(amount, policy);
    const feeOverride = onchainFee(amount, maxFee, feeRate, policy);
    const cost = spendCost({ type: 'channel-open', amount, push, maxFee });
    const stepUp = checkBudget(policy, await usedBudget(this.#db, row, this.#now()), cost);
    const payload: Payload = {
      type: 'channel-open',
      chain: row.chain,
      pubkey: row.pubkey,
      peer,
      push: push.toString(),
      feeRate,
      ...(request.announce === undefined ? {} : { announce: request.announce }),
      amount: amount.toString(),
      maxFee: maxFee.toString(),
      cost: cost.toString(),
      destination: peer,
      duplicates: await duplicatesOf(this.#db, row, peer, amount.toString(), this.#now()),
      stepUp: stepUp || feeOverride,
    };
    const common = await this.#issue(sessionHandle, nodeId, payload, identity, feeOverride, stepUp);
    this.#log.info('spend preview', { requestId, nodeId, type: 'channel-open', amountMsat: payload.amount });
    return { ...common, peer, amount: payload.amount, push: payload.push, feeRate };
  }

  async #findChannel(adapter: NodeAdapter, ref: string): Promise<Channel> {
    let cursor: string | undefined;
    do {
      const page = await adapter.channel.listChannels({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
      const found = page.items.find((c) => c.id === ref || c.shortChannelId === ref);
      if (found) return found;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    throw new AppError('not_found', 'No such channel on this node.');
  }

  async previewChannelClose(
    sessionHandle: string,
    nodeId: string,
    request: { channel: string; force: boolean; destination?: string | undefined },
    requestId: string,
  ) {
    const { row, adapter, identity } = await this.#spendingNode(nodeId);
    const ref = /^[0-9a-f]{64}$/.test(request.channel)
      ? parseChannelId(request.channel)
      : parseShortChannelId(request.channel);
    const channel = await this.#findChannel(adapter, ref);
    if (channel.state.group === 'closing' || channel.state.group === 'closed')
      throw new AppError('validation_failed', 'This channel is already closing.');
    const closeTo =
      request.destination === undefined ? undefined : this.#address(request.destination, row.network as Network);
    const policy = await loadPolicy(this.#db, row);
    // The close fee is paid from the channel's funds, so what can leave the node is at most the local balance.
    const operation: SpendOperation = {
      type: 'channel-close',
      localBalance: channel.local,
      maxFee: ZERO,
      external: closeTo !== undefined,
      force: request.force,
    };
    const cost = spendCost(operation);
    const stepUp = operationNeedsStepUp(operation, policy, await usedBudget(this.#db, row, this.#now()));
    const destination = closeTo?.address ?? `close:${channel.id}`;
    const payload: Payload = {
      type: 'channel-close',
      chain: row.chain,
      pubkey: row.pubkey,
      channelId: channel.id,
      channelRef: request.channel,
      peer: channel.peer.pubkey,
      force: request.force,
      external: closeTo !== undefined,
      ...(closeTo === undefined ? {} : { closeTo: closeTo.address }),
      amount: channel.local.toString(),
      maxFee: '0',
      cost: cost.toString(),
      destination,
      duplicates:
        closeTo === undefined
          ? []
          : await duplicatesOf(this.#db, row, destination, channel.local.toString(), this.#now()),
    };
    const common = await this.#issue(sessionHandle, nodeId, payload, identity, false, stepUp);
    this.#log.info('spend preview', { requestId, nodeId, type: 'channel-close', force: request.force });
    return {
      ...common,
      channel: request.channel,
      peer: channel.peer.pubkey,
      force: request.force,
      ...(closeTo === undefined ? {} : { destination: closeTo.address }),
      localBalance: channel.local.toString(),
    };
  }

  #replay(
    intent: {
      id: string;
      type: string;
      state: string;
      session_handle: string | null;
      confirmation_hash: string | null;
      node_id: string;
      txid: string | null;
      channel_id: string | null;
    },
    kind: ChainSpendKind,
    handle: string,
    nodeId: string,
    tokenHash: string,
  ): SpendOutcome {
    if (
      intent.type !== kind ||
      intent.session_handle !== handle ||
      intent.confirmation_hash !== tokenHash ||
      intent.node_id !== nodeId
    )
      throw new AppError('idempotency_conflict', 'This idempotency key was used for another request.');
    if (intent.state === 'reserved' || intent.state === 'sent')
      throw new AppError('idempotency_conflict', 'This spend is still running.');
    return this.#outcome(
      intent.id,
      intent.state as SpendOutcome['state'],
      intent.txid ?? undefined,
      intent.channel_id ?? undefined,
    );
  }

  #outcome(
    intentId: string,
    state: SpendOutcome['state'],
    txid?: string,
    channelId?: string,
    closeType?: SpendOutcome['closeType'],
    reason?: string | null,
  ): SpendOutcome {
    if (state === 'failed')
      throw new AppError('payment_failed', 'The spend failed; nothing was sent.', { intentId, reason: reason ?? null });
    return {
      intentId,
      state,
      ...(txid === undefined ? {} : { txid }),
      ...(channelId === undefined ? {} : { channelId }),
      ...(closeType === undefined ? {} : { closeType }),
    };
  }

  async execute(
    kind: ChainSpendKind,
    sessionHandle: string,
    nodeId: string,
    token: string,
    idempotencyKey: string,
    requestId: string,
    acknowledgeDuplicate = false,
  ): Promise<SpendOutcome> {
    const tokenHash = sha256(token);
    await liveSession(this.#db, this.#auth, sessionHandle);
    const retried = await this.#db
      .selectFrom('spend_intents')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (retried) return this.#replay(retried, kind, sessionHandle, nodeId, tokenHash);
    this.#prune();
    const confirmation = this.#confirmations.get(tokenHash);
    if (
      !confirmation ||
      confirmation.sessionHandle !== sessionHandle ||
      confirmation.nodeId !== nodeId ||
      confirmation.payload.type !== kind
    )
      throw new AppError('confirmation_invalid', 'The confirmation is missing, used, expired or not yours.');
    const payload = confirmation.payload;
    const { row, adapter, canSpend } = await this.#nodes.adapter(nodeId);
    if (!canSpend) throw new AppError('capability_missing', 'This node has no spend credential.');
    await this.#nodes.monitor.ensureChecked(nodeId);
    refuseUnlessConfirmed(this.#nodes.identity(row));

    const claim = async (trx: Db, policy: SpendPolicy, overBudgetStepUp: boolean) => {
      const live = await liveSession(trx, this.#auth, sessionHandle);
      const node = await trx.selectFrom('nodes').selectAll().where('id', '=', nodeId).executeTakeFirstOrThrow();
      refuseUnlessConfirmed(this.#nodes.identity(node));
      if (
        node.chain !== payload.chain ||
        node.pubkey !== payload.pubkey ||
        this.#confirmations.get(tokenHash) !== confirmation ||
        confirmation.expiresAt <= this.#now().getTime()
      )
        throw new AppError('confirmation_invalid', 'The confirmation is missing, used, expired or not yours.');
      const duplicates = await duplicatesOf(trx, node, payload.destination, payload.amount, this.#now());
      if (
        duplicates.some((id) => !payload.duplicates.includes(id)) ||
        (payload.duplicates.length > 0 && !acknowledgeDuplicate)
      )
        throw new AppError(
          'confirmation_invalid',
          'Review and acknowledge the duplicate-spend warning in a fresh preview.',
          { reason: 'duplicate_payment' },
        );
      // The policy may have changed since the preview: its fee rules apply again, at the confirmed figures.
      let override = false;
      if (payload.type !== 'channel-close')
        override = onchainFee(parseMsat(payload.amount), parseMsat(payload.maxFee), payload.feeRate, policy);
      if (
        overBudgetStepUp ||
        override ||
        (payload.type === 'channel-close' && payload.force) ||
        (payload.type !== 'channel-close' && payload.stepUp)
      )
        this.#auth.sessions.requireGrant(live, 'password');
      this.#confirmations.delete(tokenHash);
      const intentId = randomUUID();
      const now = this.#now().toISOString();
      await trx
        .insertInto('spend_intents')
        .values({
          id: intentId,
          node_id: nodeId,
          chain: node.chain,
          pubkey: node.pubkey,
          type: payload.type,
          payment_hash: null,
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
          created_at: now,
          updated_at: now,
          ...(payload.type === 'channel-open' ? { peer: payload.peer } : {}),
          ...(payload.type === 'channel-close'
            ? { peer: payload.peer, channel_id: payload.channelId, close_force: payload.force ? 1 : 0 }
            : {}),
        })
        .execute();
      return { intentId };
    };
    const replay = async (trx: Db) => {
      await liveSession(trx, this.#auth, sessionHandle);
      const existing = await trx
        .selectFrom('spend_intents')
        .selectAll()
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      return existing ? { replay: this.#replay(existing, kind, sessionHandle, nodeId, tokenHash) } : undefined;
    };
    const claimed = await this.#nodes.monitor.admit(nodeId, () =>
      reserveSpend<{ intentId: string } | { replay: SpendOutcome }>(
        this.#db,
        row,
        parseMsat(payload.cost),
        this.#now,
        claim,
        replay,
      ),
    );
    if ('replay' in claimed) return claimed.replay;
    const { intentId } = claimed;
    this.#log.info('spend intent', {
      requestId,
      intentId,
      sessionHandle,
      security: true,
      nodeId,
      chain: row.chain,
      type: payload.type,
      amountMsat: payload.amount,
      maxFeeMsat: payload.maxFee,
    });
    let outcome: Outcome;
    if (payload.type === 'onchain') outcome = await this.#sendOnchain(adapter, intentId, payload);
    else if (payload.type === 'channel-open') outcome = await this.#openChannel(adapter, payload);
    else outcome = await this.#closeChannel(adapter, payload);
    if (outcome.error) {
      try {
        this.#log.warn('spend not completed', {
          requestId,
          intentId,
          sessionHandle,
          security: true,
          state: outcome.state,
          code: outcome.errorCode ?? undefined,
          nodeCode: outcome.error instanceof AdapterError ? outcome.error.nodeCode : undefined,
          detail: outcome.error instanceof AdapterError ? nodeDetail(outcome.error.detail) : undefined,
        });
      } catch {
        /* The database result remains authoritative. */
      }
    }
    await this.#db
      .updateTable('spend_intents')
      .set({
        state: outcome.state,
        fee_msat: outcome.fee === undefined ? null : toMsatString(outcome.fee),
        error_code: outcome.errorCode ?? null,
        ...(outcome.txid === undefined ? {} : { txid: outcome.txid }),
        ...(outcome.channelId === undefined ? {} : { channel_id: outcome.channelId }),
        // The sealed PSBT is kept only while the outcome is unknown (recovery may need to release its inputs).
        ...(outcome.state === 'unknown' ? {} : { psbt_key_id: null, psbt_nonce: null, psbt_ciphertext: null }),
        updated_at: this.#now().toISOString(),
      })
      .where('id', '=', intentId)
      .execute();
    try {
      this.#log.info('spend result', {
        requestId,
        intentId,
        sessionHandle,
        security: true,
        nodeId,
        type: payload.type,
        state: outcome.state,
        ...(outcome.txid === undefined ? {} : { txid: outcome.txid }),
        feeMsat: outcome.fee === undefined ? undefined : toMsatString(outcome.fee),
        code: outcome.errorCode ?? undefined,
      });
    } catch {
      /* A failed log sink must not replace the durable outcome. */
    }
    return this.#outcome(
      intentId,
      outcome.state,
      outcome.txid,
      outcome.channelId,
      outcome.closeType,
      outcome.errorCode,
    );
  }

  // Build first, check, then broadcast (spend policy §4): `txprepare` reserves inputs and broadcasts nothing; its
  // txid and sealed PSBT are stored before `txsend`, so the spend can be found or released after a crash.
  async #sendOnchain(
    adapter: NodeAdapter,
    intentId: string,
    payload: Extract<Payload, { type: 'onchain' }>,
  ): Promise<Outcome> {
    let prepared: { txid: Txid; psbt: string };
    try {
      prepared = await adapter.onchain.prepare({
        outputs: [{ address: payload.address, amount: parseMsat(payload.amount) }],
        feeRate: payload.feeRate,
      });
    } catch (err) {
      // Nothing can be broadcast without `txsend`.
      return { state: 'failed', errorCode: errorCode(err), error: err };
    }
    const sealed = this.#vault.sealSecret(prepared.psbt, `intent_psbt:${intentId}`);
    await this.#db
      .updateTable('spend_intents')
      .set({
        txid: prepared.txid,
        psbt_key_id: sealed.key_id,
        psbt_nonce: sealed.nonce,
        psbt_ciphertext: sealed.ciphertext,
        updated_at: this.#now().toISOString(),
      })
      .where('id', '=', intentId)
      .execute();
    let fee: Msat;
    try {
      const read = readPsbt(prepared.psbt);
      if (read.txid !== prepared.txid) throw new PsbtError('txid differs from the node reply');
      const paid = read.outputs.filter((o) => o.script === payload.script && o.amount === parseMsat(payload.amount));
      if (paid.length !== 1) throw new PsbtError('no single output pays the confirmed address and amount');
      fee = read.fee;
    } catch (err) {
      await this.#release(adapter, prepared);
      return { state: 'failed', errorCode: 'node_bad_response', txid: prepared.txid, error: err };
    }
    if (fee > parseMsat(payload.maxFee)) {
      await this.#release(adapter, prepared);
      return { state: 'failed', errorCode: 'fee_cap_exceeded', txid: prepared.txid, fee, error: undefined };
    }
    try {
      const sent = await adapter.onchain.send(prepared.txid);
      if (sent.txid !== prepared.txid)
        return { state: 'unknown', errorCode: 'node_bad_response', txid: prepared.txid, fee, error: undefined };
      return { state: 'succeeded', txid: prepared.txid, fee };
    } catch (err) {
      if (err instanceof AdapterError && (!err.sent || err.definitive)) {
        await this.#release(adapter, prepared);
        return { state: 'failed', errorCode: err.code, txid: prepared.txid, error: err };
      }
      return { state: 'unknown', errorCode: errorCode(err), txid: prepared.txid, fee, error: err };
    }
  }

  // Releases the inputs of a prepared transaction that will not be sent: `txdiscard`, else `unreserveinputs`.
  async #release(adapter: NodeAdapter, prepared: { txid: Txid; psbt: string }): Promise<void> {
    try {
      await adapter.onchain.discard(prepared.txid);
    } catch {
      try {
        await adapter.onchain.unreserve(prepared.psbt);
      } catch {
        /* The node releases reservations by itself after a while; nothing was broadcast. */
      }
    }
  }

  async #openChannel(adapter: NodeAdapter, payload: Extract<Payload, { type: 'channel-open' }>): Promise<Outcome> {
    try {
      const opened = await adapter.channel.openChannel({
        peer: parsePubkey(payload.peer),
        amount: parseMsat(payload.amount),
        feeRate: payload.feeRate,
        ...(payload.push === '0' ? {} : { pushMsat: parseMsat(payload.push) }),
        ...(payload.announce === undefined ? {} : { announce: payload.announce }),
      });
      return { state: 'succeeded', txid: parseTxid(opened.txid), channelId: opened.channelId };
    } catch (err) {
      return classify(err);
    }
  }

  async #closeChannel(adapter: NodeAdapter, payload: Extract<Payload, { type: 'channel-close' }>): Promise<Outcome> {
    try {
      const closed = await adapter.channel.closeChannel({
        channel: parseChannelId(payload.channelId),
        force: payload.force,
        ...(payload.closeTo === undefined ? {} : { destination: payload.closeTo }),
      });
      // `pending`: the node accepted the close and waits for the peer; the funds stay in the channel until then.
      return {
        state: 'succeeded',
        channelId: payload.channelId,
        closeType: closed.type,
        ...('txids' in closed && closed.txids[0] !== undefined ? { txid: closed.txids[0] } : {}),
      };
    } catch (err) {
      return { ...classify(err), channelId: payload.channelId };
    }
  }

  // Peer connection and disconnection: declared zero-cost actions with the spend credential (spend policy §10).
  async peer(
    sessionHandle: string,
    nodeId: string,
    action: { connect: string } | { disconnect: string; force: boolean },
    requestId: string,
  ): Promise<{ pubkey: string }> {
    spendCost({ type: 'action', cost: () => ZERO });
    await liveSession(this.#db, this.#auth, sessionHandle);
    const { adapter } = await this.#spendingNode(nodeId);
    let pubkey: string;
    if ('connect' in action) pubkey = (await adapter.peer.connect(action.connect)).pubkey;
    else {
      pubkey = parsePubkey(action.disconnect);
      await adapter.peer.disconnect(parsePubkey(action.disconnect), { force: action.force });
    }
    this.#log.warn('peer changed', {
      requestId,
      nodeId,
      sessionHandle,
      security: true,
      action: 'connect' in action ? 'connect' : 'disconnect',
      peer: pubkey,
    });
    return { pubkey };
  }
}

interface Outcome {
  state: SpendOutcome['state'];
  errorCode?: string | null;
  error?: unknown;
  txid?: Txid;
  channelId?: string;
  fee?: Msat;
  closeType?: SpendOutcome['closeType'];
}

function errorCode(err: unknown): string {
  return err instanceof AdapterError ? err.code : 'internal';
}

// Only errors raised before the request was sent, or node replies that definitively say nothing moved, are failures
// (spend policy §3); anything else may have moved funds.
function classify(err: unknown): Outcome {
  const definite = err instanceof AdapterError && (!err.sent || err.definitive);
  return { state: definite ? 'failed' : 'unknown', errorCode: errorCode(err), error: err };
}
