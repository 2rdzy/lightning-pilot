// Nodes (minimal): add a CLN node with a view rune and an optional spend rune, check its chain identity, and read
// its info and balances. Credentials are encrypted by the vault and never leave the server.
import { randomUUID } from 'node:crypto';
import { createClnAdapter } from '@lightning-pilot/adapter-cln';
import { PROFILES } from '@lightning-pilot/chain';
import {
  AppError,
  parsePubkey,
  type AddNodeRequest,
  type Chain,
  type ChainIdentityState,
  type Network,
  type NodeAdapter,
} from '@lightning-pilot/core';
import { writeTx, type Db } from '../../storage/db.ts';
import type { DB } from '../../storage/schema.ts';
import type { Logger } from '../../logging/logger.ts';
import type { Vault } from '../vault/index.ts';
import { IdentityMonitor, identityOfRow, runIdentityCheck, type IdentityListener } from './identity/index.ts';

export type NodeRow = DB['nodes'];

export interface NodeConnection {
  url: string;
  caCertificate: string;
  serverName: string;
  viewRune: string;
  spendRune?: string;
}

export type AdapterFactory = (connection: NodeConnection) => NodeAdapter;

export const clnAdapterFactory: AdapterFactory = (connection) => createClnAdapter(connection);

export interface NodesOptions {
  db: Db;
  vault: Vault;
  logger: Logger;
  dev: boolean;
  maxNodes: number;
  adapterFactory?: AdapterFactory;
  now?: () => Date;
  // How often the identity monitor polls each node (ms), and who hears about identity changes.
  identityIntervalMs?: number;
  onIdentityUpdate?: IdentityListener;
}

export interface NodeSummaryData {
  id: string;
  name: string;
  chain: Chain;
  network: Network;
  implementation: 'cln' | 'lnd';
  pubkey: string;
  canSpend: boolean;
  chainIdentity: ChainIdentityState;
  createdAt: string;
}

export class NodesService {
  readonly #db: Db;
  readonly #vault: Vault;
  readonly #log: Logger;
  readonly #dev: boolean;
  readonly #maxNodes: number;
  readonly #factory: AdapterFactory;
  readonly #now: () => Date;
  readonly #adapters = new Map<string, NodeAdapter>();
  // Keeps the stored chain identity current (identity/monitor.ts); started by main.ts, not by buildServer.
  readonly monitor: IdentityMonitor;

  constructor(options: NodesOptions) {
    this.#db = options.db;
    this.#vault = options.vault;
    this.#log = options.logger.child('nodes');
    this.#dev = options.dev;
    this.#maxNodes = options.maxNodes;
    this.#factory = options.adapterFactory ?? clnAdapterFactory;
    this.#now = options.now ?? (() => new Date());
    this.monitor = new IdentityMonitor({
      db: this.#db,
      logger: options.logger,
      load: async (id) => this.adapter(id),
      ...(options.identityIntervalMs === undefined ? {} : { intervalMs: options.identityIntervalMs }),
      ...(options.onIdentityUpdate ? { onUpdate: options.onIdentityUpdate } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  // Runs the chain identity check against a node (identity/check.ts).
  checkIdentity(adapter: NodeAdapter, chain: Chain, network: Network) {
    return runIdentityCheck(adapter, chain, network, this.#now());
  }

  async add(input: AddNodeRequest & { serverName: string }, requestId: string): Promise<NodeSummaryData> {
    if (!PROFILES[input.chain].networks.includes(input.network)) {
      throw new AppError('validation_failed', `${PROFILES[input.chain].displayName} has no ${input.network} network.`);
    }
    // regtest chains can be made to look like anything, so they are only for development (and tests).
    if (input.network === 'regtest' && !this.#dev) {
      throw new AppError('validation_failed', 'regtest nodes can only be added in development mode.');
    }
    const count = await this.#db
      .selectFrom('nodes')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= this.#maxNodes)
      throw new AppError('validation_failed', 'The maximum number of nodes is reached.');

    const connection: NodeConnection = {
      url: input.url,
      caCertificate: input.caCertificate,
      serverName: input.serverName,
      viewRune: input.viewRune,
      ...(input.spendRune === undefined ? {} : { spendRune: input.spendRune }),
    };
    const adapter = this.#factory(connection);
    const { facts, identity, error } = await this.checkIdentity(adapter, input.chain, input.network);
    if (error !== undefined) throw error;
    if (!facts || identity.state === 'refused') {
      this.#log.warn('node refused by chain identity check', {
        requestId,
        chain: input.chain,
        failedCheck: identity.failedCheck,
        detail: identity.detail,
      });
      throw new AppError('chain_refused', 'This node does not match the chosen chain.', {
        failedCheck: identity.failedCheck,
        detail: identity.detail,
      });
    }

    const id = randomUUID();
    const now = this.#now().toISOString();
    try {
      await writeTx(this.#db, async (trx) => {
        await trx
          .insertInto('nodes')
          .values({
            id,
            name: input.name,
            chain: input.chain,
            network: input.network,
            implementation: 'cln',
            url: input.url,
            ca_certificate: input.caCertificate,
            server_name: input.serverName,
            pubkey: facts.pubkey,
            identity_state: identity.state,
            identity_failed_check: identity.failedCheck ?? null,
            identity_detail: identity.detail ?? null,
            identity_checked_at: identity.checkedAt,
            created_at: now,
          })
          .execute();
        await this.#vault.put(trx, id, 'read', input.viewRune);
        if (input.spendRune !== undefined) await this.#vault.put(trx, id, 'spend', input.spendRune);
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        throw new AppError('validation_failed', 'This node has already been added.');
      }
      throw err;
    }
    this.#adapters.set(id, adapter);
    this.monitor.recordBaseline(id, facts);
    this.#log.info('node added', {
      requestId,
      nodeId: id,
      chain: input.chain,
      network: input.network,
      pubkey: facts.pubkey,
      identity: identity.state,
      canSpend: input.spendRune !== undefined,
    });
    return this.summary(id);
  }

  async #row(id: string): Promise<NodeRow> {
    const row = await this.#db.selectFrom('nodes').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('not_found', 'No such node.');
    return row;
  }

  async #canSpend(id: string): Promise<boolean> {
    const row = await this.#db
      .selectFrom('credentials')
      .select('kind')
      .where('node_id', '=', id)
      .where('kind', '=', 'spend')
      .executeTakeFirst();
    return row !== undefined;
  }

  async #toSummary(row: NodeRow): Promise<NodeSummaryData> {
    return {
      id: row.id,
      name: row.name,
      chain: row.chain as Chain,
      network: row.network as Network,
      implementation: row.implementation as 'cln' | 'lnd',
      pubkey: parsePubkey(row.pubkey),
      canSpend: await this.#canSpend(row.id),
      chainIdentity: identityOfRow(row),
      createdAt: row.created_at,
    };
  }

  async summary(id: string): Promise<NodeSummaryData> {
    return this.#toSummary(await this.#row(id));
  }

  async list(): Promise<NodeSummaryData[]> {
    const rows = await this.#db.selectFrom('nodes').selectAll().orderBy('created_at').execute();
    return Promise.all(rows.map((r) => this.#toSummary(r)));
  }

  // The node's adapter, built from its stored connection and decrypted credentials on first use.
  async adapter(id: string): Promise<{ row: NodeRow; adapter: NodeAdapter; canSpend: boolean }> {
    const row = await this.#row(id);
    let adapter = this.#adapters.get(id);
    if (!adapter) {
      const viewRune = await this.#vault.get(this.#db, id, 'read');
      if (viewRune === undefined) throw new AppError('node_credential_revoked', 'The node has no view credential.');
      const spendRune = await this.#vault.get(this.#db, id, 'spend');
      adapter = this.#factory({
        url: row.url,
        caCertificate: row.ca_certificate,
        serverName: row.server_name,
        viewRune,
        ...(spendRune === undefined ? {} : { spendRune }),
      });
      this.#adapters.set(id, adapter);
    }
    return { row, adapter, canSpend: await this.#canSpend(id) };
  }

  identity(row: NodeRow): ChainIdentityState {
    return identityOfRow(row);
  }
}
