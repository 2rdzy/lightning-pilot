// Keeps every node's chain identity current (chain-identity spec §4 "When"): a full check at start, when the node
// answers again after being unreachable, when its version changes and on every new block; and, before a spend
// preview, a cheap `getinfo` comparison with the facts of the last full check, which runs a full check first when
// anything differs.
//
// New blocks and reconnects are found by polling `getinfo` (default every 30 s, like the spec's channel polling):
// the adapter has no block or connection events yet (CLN `wait`, LND subscriptions: the complete adapter), and the
// node reports no start time, so a restart shows only as a version change or an unreachable period. A full check
// fetches the tip block; a poll does not.
import type {
  Chain,
  ChainIdentityState,
  FailedCheck,
  NodeAdapter,
  NodeFacts,
  NodeRef,
  Network,
} from '@lightning-pilot/core';
import { parsePubkey } from '@lightning-pilot/core';
import type { Db } from '../../../storage/db.ts';
import type { DB } from '../../../storage/schema.ts';
import type { Logger } from '../../../logging/logger.ts';
import { runIdentityCheck } from './check.ts';

type NodeRow = import('kysely').Selectable<DB['nodes']>;

export const DEFAULT_IDENTITY_INTERVAL_MS = 30_000;

// Why a full check ran; logged with the result.
export type CheckReason =
  'added' | 'start' | 'block' | 'version' | 'sync' | 'reconnect' | 'unreachable' | 'preview' | 'other_node';

// Sent when a node's state or failed check changes; the events module turns it into `chain_identity.updated`.
export interface IdentityUpdate {
  nodeId: string;
  node: NodeRef;
  state: ChainIdentityState;
  previous: ChainIdentityState;
}
export type IdentityListener = (update: IdentityUpdate) => void;

export interface IdentityMonitorOptions {
  db: Db;
  logger: Logger;
  // The node's stored row and its adapter (built on first use).
  load: (nodeId: string) => Promise<{ row: NodeRow; adapter: NodeAdapter }>;
  intervalMs?: number;
  onUpdate?: IdentityListener;
  now?: () => Date;
}

// What the last full check saw; a poll or a preview that sees anything else runs a full check.
interface Baseline {
  pubkey: string;
  network: string;
  blockHeight: number;
  version: string;
  synced: boolean;
}

const baselineOf = (facts: NodeFacts): Baseline => ({
  pubkey: facts.pubkey,
  network: facts.networkRaw,
  blockHeight: facts.blockHeight,
  version: facts.version,
  synced: facts.synced,
});

// Which difference matters, in order; undefined when the node looks as it did.
function changeOf(before: Baseline | undefined, facts: NodeFacts): CheckReason | undefined {
  if (!before) return 'preview';
  if (before.pubkey !== facts.pubkey || before.network !== facts.networkRaw || before.version !== facts.version) {
    return 'version';
  }
  if (before.blockHeight !== facts.blockHeight) return 'block';
  if (before.synced !== facts.synced) return 'sync';
  return undefined;
}

export const identityOfRow = (row: NodeRow): ChainIdentityState => ({
  state: row.identity_state as ChainIdentityState['state'],
  profile: row.chain as Chain,
  checkedAt: row.identity_checked_at,
  ...(row.identity_failed_check ? { failedCheck: row.identity_failed_check as FailedCheck } : {}),
  ...(row.identity_detail ? { detail: row.identity_detail } : {}),
});

export class IdentityMonitor {
  readonly #db: Db;
  readonly #log: Logger;
  readonly #load: IdentityMonitorOptions['load'];
  readonly #intervalMs: number;
  readonly #onUpdate: IdentityListener | undefined;
  readonly #now: () => Date;
  readonly #baselines = new Map<string, Baseline>();
  readonly #unreachable = new Set<string>();
  // One full check per node at a time: callers that ask while one runs share its result.
  readonly #running = new Map<string, Promise<ChainIdentityState>>();
  // Per node, full checks and spend admissions (admit) run one after the other, so each admission sees the outcome
  // of every check that started before it, and a check that starts later finds the spend already admitted.
  readonly #turns = new Map<string, Promise<unknown>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling: Promise<void> | undefined;

  constructor(options: IdentityMonitorOptions) {
    this.#db = options.db;
    this.#log = options.logger.child('identity');
    this.#load = options.load;
    this.#intervalMs = options.intervalMs ?? DEFAULT_IDENTITY_INTERVAL_MS;
    this.#onUpdate = options.onUpdate;
    this.#now = options.now ?? (() => new Date());
  }

  // Called by NodesService.add with the facts of the check that admitted the node.
  recordBaseline(nodeId: string, facts: NodeFacts): void {
    this.#baselines.set(nodeId, baselineOf(facts));
    this.#unreachable.delete(nodeId);
  }

  forget(nodeId: string): void {
    this.#baselines.delete(nodeId);
    this.#unreachable.delete(nodeId);
  }

  // Full check of every node now, then a poll every interval. Does not wait for the checks.
  start(): void {
    if (this.#timer) return;
    void this.#all('start');
    this.#timer = setInterval(() => {
      if (!this.#polling) this.#polling = this.poll().finally(() => (this.#polling = undefined));
    }, this.#intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#polling;
    await Promise.allSettled([...this.#running.values()]);
  }

  async #ids(): Promise<string[]> {
    const rows = await this.#db.selectFrom('nodes').where('removed_at', 'is', null).select('id').execute();
    return rows.map((r) => r.id);
  }

  async #all(reason: CheckReason): Promise<void> {
    for (const id of await this.#ids()) {
      await this.fullCheck(id, reason).catch((err: unknown) =>
        this.#log.error('identity check failed', { nodeId: id, err }),
      );
    }
  }

  // One round: a cheap getinfo per node, and a full check where something changed.
  async poll(): Promise<void> {
    for (const id of await this.#ids()) {
      if (this.#running.has(id)) continue;
      try {
        const { adapter } = await this.#load(id);
        let facts: NodeFacts;
        try {
          facts = await adapter.node.getInfo();
        } catch {
          if (!this.#unreachable.has(id)) await this.fullCheck(id, 'unreachable');
          continue;
        }
        // The full check compares the key with the stored one; here only a change since that check matters, so a node
        // refused for answering with another key is not fetched again every round.
        const reason = this.#unreachable.has(id) ? 'reconnect' : changeOf(this.#baselines.get(id), facts);
        if (reason) await this.fullCheck(id, reason === 'preview' ? 'start' : reason);
      } catch (err) {
        this.#log.error('identity poll failed', { nodeId: id, err });
      }
    }
  }

  // Before a spend preview: compare a fresh getinfo with the last full check, run a full check first if anything
  // differs, then return the stored state (the database is the source of truth for the state).
  async ensureFresh(nodeId: string): Promise<ChainIdentityState> {
    const pending = this.#running.get(nodeId);
    if (pending) await pending;
    const { row, adapter } = await this.#load(nodeId);
    let facts: NodeFacts | undefined;
    try {
      facts = await adapter.node.getInfo();
    } catch {
      facts = undefined;
    }
    const reason =
      facts === undefined
        ? 'unreachable'
        : facts.pubkey !== row.pubkey
          ? 'other_node'
          : this.#unreachable.has(nodeId)
            ? 'reconnect'
            : changeOf(this.#baselines.get(nodeId), facts);
    if (reason) await this.fullCheck(nodeId, reason);
    // Read after any check that ran meanwhile: the row loaded above may be older than it.
    return this.#inTurn(nodeId, async () =>
      identityOfRow(
        await this.#db
          .selectFrom('nodes')
          .where('removed_at', 'is', null)
          .selectAll()
          .where('id', '=', nodeId)
          .executeTakeFirstOrThrow(),
      ),
    );
  }

  // Before a new spend: a node without a full check in this process (start-up has not reached it yet, or it was
  // unreachable) is checked first, so a state stored by an earlier run is never what admits a spend.
  async ensureChecked(nodeId: string): Promise<void> {
    if (!this.#baselines.has(nodeId)) await this.fullCheck(nodeId, 'start');
  }

  // Runs a new spend's admission (the transaction that claims it, which checks the stored state again) in the node's
  // turn: after every full check that started before it, and before any that starts later. Spends admitted before a
  // refusal are in flight and stay tracked (chain-identity spec §5). No node call may run inside `admit`.
  admit<T>(nodeId: string, admission: () => Promise<T>): Promise<T> {
    return this.#inTurn(nodeId, admission);
  }

  fullCheck(nodeId: string, reason: CheckReason): Promise<ChainIdentityState> {
    const running = this.#running.get(nodeId);
    if (running) return running;
    const run = this.#inTurn(nodeId, () => this.#fullCheck(nodeId, reason)).finally(() => this.#running.delete(nodeId));
    this.#running.set(nodeId, run);
    return run;
  }

  #inTurn<T>(nodeId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.#turns.get(nodeId) ?? Promise.resolve()).then(task);
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.#turns.set(nodeId, done);
    void done.then(() => {
      if (this.#turns.get(nodeId) === done) this.#turns.delete(nodeId);
    });
    return run;
  }

  async #fullCheck(nodeId: string, reason: CheckReason): Promise<ChainIdentityState> {
    const { row, adapter } = await this.#load(nodeId);
    const chain = row.chain as Chain;
    const network = row.network as Network;
    const { facts, identity: checked } = await runIdentityCheck(adapter, chain, network, this.#now());
    let identity = checked;
    if (facts === undefined) {
      this.#unreachable.add(nodeId);
    } else {
      this.#unreachable.delete(nodeId);
      this.#baselines.set(nodeId, baselineOf(facts));
      // The checks look at the chain, not at which node answers: a different key at the same address is another
      // node, which was never checked or approved.
      if (facts.pubkey !== row.pubkey) {
        identity = {
          state: 'refused',
          profile: chain,
          checkedAt: this.#now().toISOString(),
          failedCheck: 'node',
          detail: 'the node at this address has another public key than the node that was added',
        };
      }
    }

    const previous = identityOfRow(row);
    await this.#db
      .updateTable('nodes')
      .set({
        identity_state: identity.state,
        identity_failed_check: identity.failedCheck ?? null,
        identity_detail: identity.detail ?? null,
        identity_checked_at: identity.checkedAt,
      })
      .where('id', '=', nodeId)
      .execute();

    const changed = previous.state !== identity.state || previous.failedCheck !== identity.failedCheck;
    const fields = {
      nodeId,
      reason,
      state: identity.state,
      failedCheck: identity.failedCheck,
      detail: identity.detail,
    };
    if (changed && identity.state === 'refused')
      this.#log.warn('chain identity refused', { ...fields, previous: previous.state });
    else if (changed) this.#log.info('chain identity changed', { ...fields, previous: previous.state });
    else this.#log.debug('chain identity checked', fields);
    if (changed && this.#onUpdate) {
      const node: NodeRef = { chain, network, pubkey: parsePubkey(row.pubkey) };
      try {
        this.#onUpdate({ nodeId, node, state: identity, previous });
      } catch (err) {
        this.#log.error('identity listener failed', { nodeId, err });
      }
    }
    return identity;
  }
}
