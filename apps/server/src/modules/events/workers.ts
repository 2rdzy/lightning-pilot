import { setTimeout as delay } from 'node:timers/promises';
import {
  AdapterError,
  parsePubkey,
  type Chain,
  type Network,
  type NodeAdapter,
  type NodeRef,
  type Page,
  type PageRequest,
} from '@lightning-pilot/core';
import type { Db } from '../../storage/db.ts';
import type { Logger } from '../../logging/logger.ts';
import type { NodesService, NodeRow } from '../nodes/index.ts';
import { EventBus } from './bus.ts';
import { wire, type EventType } from './schemas.ts';

export interface WorkerOptions {
  db: Db;
  nodes: NodesService;
  bus: EventBus;
  logger: Logger;
  wakeRecovery: (nodeId: string, paymentHash?: string) => void;
  intervalMs?: number;
  retryMs?: number;
}

class SnapshotLimit extends Error {}

// A repeated cursor must not turn one poll into an endless loop. The snapshot cap bounds memory as well;
// oversized lists cause reload, so the browser can use the paged read APIs instead.
async function allPages<T>(read: (page: PageRequest) => Promise<Page<T>>, signal: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await read({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    items.push(...page.items);
    if (items.length > 10_000 || (page.nextCursor !== undefined && seen.has(page.nextCursor)))
      throw new SnapshotLimit('Event snapshot cannot be bounded');
    cursor = page.nextCursor;
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor !== undefined);
  return items;
}

class NodeWorker {
  readonly abort = new AbortController();
  readonly done: Promise<void>;
  readonly #options: WorkerOptions;
  readonly #row: NodeRow;
  readonly #node: NodeRef;
  readonly #snapshots = new Map<string, Map<string, string>>();
  #poll: Promise<void> | undefined;
  #again = false;
  #nextFeesAt = 0;
  #adapter: NodeAdapter | undefined;
  #reachability: string | undefined;
  constructor(options: WorkerOptions, row: NodeRow) {
    this.#options = options;
    this.#row = row;
    this.#node = { chain: row.chain as Chain, network: row.network as Network, pubkey: parsePubkey(row.pubkey) };
    this.done = this.#run();
  }
  stop(): void {
    this.abort.abort();
  }

  #publish(type: EventType, data: unknown): void {
    if (!this.abort.signal.aborted) this.#options.bus.publish(type, data, this.#node);
  }
  #reach(reachable: boolean, credential: 'ok' | 'revoked' = 'ok'): void {
    const state = `${reachable}:${credential}`;
    if (this.#reachability !== state) {
      this.#reachability = state;
      this.#publish('node.reachability', { reachable, credential });
    }
  }
  #compare(type: EventType, entries: { key: string; data: unknown }[], removals = false): void {
    const previous = this.#snapshots.get(type);
    const current = new Map(entries.map(({ key, data }) => [key, JSON.stringify(wire(data))]));
    for (const entry of entries)
      if (previous?.get(entry.key) !== current.get(entry.key)) this.#publish(type, entry.data);
    if (removals && previous && [...previous.keys()].some((key) => !current.has(key)))
      this.#publish('reload', { reason: 'snapshot_changed' });
    this.#snapshots.set(type, current);
  }

  #refresh(): Promise<void> {
    this.#again = true;
    if (this.#poll) return this.#poll;
    this.#poll = (async () => {
      while (this.#again && !this.abort.signal.aborted) {
        this.#again = false;
        const adapter = this.#adapter;
        if (!adapter) return;
        const tasks = [
          async () => {
            const channels = await allPages((p) => adapter.channel.listChannels(p), this.abort.signal);
            this.#compare(
              'channel.updated',
              channels.map((c) => ({
                key: c.id,
                data: { channelId: c.id, state: c.state, local: c.local, remote: c.remote },
              })),
              true,
            );
          },
          async () => {
            const peers = await adapter.peer.listPeers();
            if (peers.length > 10_000) throw new SnapshotLimit('Event peer snapshot cannot be bounded');
            this.#compare(
              'peer.updated',
              peers.map((p) => ({ key: p.pubkey, data: { pubkey: p.pubkey, connected: p.connected } })),
              true,
            );
          },
          async () => {
            const txs = await allPages((p) => adapter.onchain.listTransactions(p), this.abort.signal);
            this.#compare(
              'onchain.updated',
              txs.map((t) => ({ key: t.txid, data: t })),
              true,
            );
          },
          async () => {
            this.#compare('balances.updated', [{ key: 'balances', data: await adapter.balance.getBalances() }]);
          },
          async () => {
            if (Date.now() < this.#nextFeesAt) return;
            this.#compare('fees.updated', [{ key: 'fees', data: await adapter.chain.getFeeEstimates() }]);
            this.#nextFeesAt = Date.now() + 180_000;
          },
        ];
        // Independent read failures do not starve other snapshots; no spend methods are called here.
        for (const task of tasks) {
          if (this.abort.signal.aborted) break;
          try {
            await task();
          } catch (err) {
            if (err instanceof SnapshotLimit) this.#publish('reload', { reason: 'snapshot_changed' });
            if (!this.abort.signal.aborted)
              this.#options.logger.warn('event snapshot not readable', { nodeId: this.#row.id });
          }
        }
      }
    })().finally(() => {
      this.#poll = undefined;
    });
    return this.#poll;
  }

  async #run(): Promise<void> {
    const { db, nodes, wakeRecovery, logger } = this.#options;
    const signal = this.abort.signal;
    let retry = this.#options.retryMs ?? 1000;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      while (!signal.aborted) {
        try {
          const { adapter } = await nodes.adapter(this.#row.id);
          const facts = await adapter.node.getInfo();
          if (facts.pubkey !== this.#row.pubkey)
            throw new AdapterError({ code: 'node_bad_response', sent: false, definitive: true });
          if (this.#reachability?.startsWith('false:')) await nodes.monitor.fullCheck(this.#row.id, 'reconnect');
          this.#adapter = adapter;
          this.#reach(true);
          const saved = await db
            .selectFrom('event_cursors')
            .select('cursor')
            .where('node_id', '=', this.#row.id)
            .executeTakeFirst();
          const source = adapter.events.subscribe(saved?.cursor, signal);
          // Establish subscription before the first snapshot so events during slow reads are not missed.
          const consume = async () => {
            for await (const { event, cursor } of source) {
              if (signal.aborted) break;
              this.#reach(true);
              try {
                this.#publish(event.type, event.data);
              } catch {
                // A malformed/oversized advisory payload must not pin the ingestion cursor forever.
                this.#publish('reload', { reason: 'snapshot_changed' });
                logger.warn('node event not publishable', { nodeId: this.#row.id, type: event.type });
              }
              await db
                .insertInto('event_cursors')
                .values({ node_id: this.#row.id, cursor })
                .onConflict((oc) => oc.column('node_id').doUpdateSet({ cursor }))
                .execute();
              retry = this.#options.retryMs ?? 1000;
              if (event.type === 'payment.updated') wakeRecovery(this.#row.id, event.data.paymentHash);
              if (event.type === 'block.new') {
                this.#nextFeesAt = 0;
                wakeRecovery(this.#row.id);
                await nodes.monitor.fullCheck(this.#row.id, 'block');
              }
              if (event.type !== 'invoice.expired') void this.#refresh();
            }
            if (!signal.aborted) throw new Error('Node event stream ended');
          };
          const consuming = consume();
          // Attach a rejection handler before awaiting other work, including node outages at subscription start.
          void consuming.catch(() => {});
          void this.#refresh();
          timer = setInterval(() => {
            void this.#refresh();
          }, this.#options.intervalMs ?? 30_000);
          timer.unref();
          await consuming;
        } catch (err) {
          if (signal.aborted) break;
          this.#reach(false, err instanceof AdapterError && err.code === 'node_credential_revoked' ? 'revoked' : 'ok');
          logger.warn('node event subscription retry', {
            nodeId: this.#row.id,
            code: err instanceof AdapterError ? err.code : 'internal',
          });
        } finally {
          if (timer) clearInterval(timer);
          timer = undefined;
          await this.#poll;
        }
        await delay(retry, undefined, { signal });
        retry = Math.min(retry * 2, 60_000);
      }
    } catch (err) {
      if (!signal.aborted) logger.error('node event worker stopped', { nodeId: this.#row.id, err });
    }
  }
}

const connectionSignature = (row: NodeRow | undefined, credentials: unknown) =>
  JSON.stringify([
    row && {
      id: row.id,
      chain: row.chain,
      network: row.network,
      pubkey: row.pubkey,
      url: row.url,
      ca: row.ca_certificate,
      serverName: row.server_name,
    },
    credentials,
  ]);

export class EventWorkers {
  readonly #options: WorkerOptions;
  readonly #workers = new Map<string, { signature: string; worker: NodeWorker }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #sync: Promise<void> | undefined;
  #stopped = false;
  constructor(options: WorkerOptions) {
    this.#options = options;
  }
  start(): void {
    if (this.#timer || this.#stopped) return;
    void this.reconcile();
    this.#timer = setInterval(() => {
      void this.reconcile();
    }, this.#options.intervalMs ?? 30_000);
    this.#timer.unref();
  }
  reconcile(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#sync) return this.#sync;
    this.#sync = this.#reconcile()
      .catch((err: unknown) => {
        this.#options.logger.error('event workers not reconciled', { err });
      })
      .finally(() => {
        this.#sync = undefined;
      });
    return this.#sync;
  }
  async #reconcile(): Promise<void> {
    const rows = await this.#options.db.selectFrom('nodes').selectAll().execute();
    const credentials = await this.#options.db.selectFrom('credentials').selectAll().execute();
    for (const [id, entry] of this.#workers) {
      const row = rows.find((r) => r.id === id);
      const signature = connectionSignature(
        row,
        credentials.filter((c) => c.node_id === id),
      );
      if (!row || signature !== entry.signature) {
        entry.worker.stop();
        await entry.worker.done;
        this.#workers.delete(id);
      }
    }
    for (const row of rows) {
      if (this.#stopped) break;
      if (!this.#workers.has(row.id)) {
        const signature = connectionSignature(
          row,
          credentials.filter((c) => c.node_id === row.id),
        );
        this.#workers.set(row.id, { signature, worker: new NodeWorker(this.#options, row) });
      }
    }
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#sync;
    for (const { worker } of this.#workers.values()) worker.stop();
    await Promise.all([...this.#workers.values()].map(({ worker }) => worker.done));
    this.#workers.clear();
  }
}
