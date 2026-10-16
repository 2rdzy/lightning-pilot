import { isIP } from 'node:net';
// Nodes (minimal): add a CLN node with a view rune and an optional spend rune, check its chain identity, and read
// its info and balances. Credentials are encrypted by the vault and never leave the server.
import { randomUUID } from 'node:crypto';
import { METHODS, isNodeAddress } from '@lightning-pilot/adapter-cln';
import { createClnAdapter } from '@lightning-pilot/adapter-cln';
import { PROFILES } from '@lightning-pilot/chain';
import {
  AppError,
  AdapterError,
  parsePubkey,
  type ManageNodeRequest,
  type AccessLevel,
  SpendPolicy,
  NodeCredentialBlock,
  limitsAreOrdered,
  capabilitiesAllowed,
  nodeMethodsFor,
  type Chain,
  type ChainIdentityState,
  type Network,
  type NodeAdapter,
  type Capability,
} from '@lightning-pilot/core';
import { writeTx, type Db } from '../../storage/db.ts';
import type { DB } from '../../storage/schema.ts';
import type { Logger } from '../../logging/logger.ts';
import type { Vault } from '../vault/index.ts';
import { inspectRune, verifyRunes, ADMIN_WARNING } from './credentials.ts';
import { IdentityMonitor, identityOfRow, runIdentityCheck, type IdentityListener } from './identity/index.ts';

export type NodeRow = import('kysely').Selectable<DB['nodes']>;

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
  accessLevel: AccessLevel;
  adminCredential: boolean;
  limitsRequired: boolean;
}

export interface PreparedNode {
  input: ManageNodeRequest & { serverName: string };
  row: NodeRow;
  adapter: NodeAdapter;
  facts: Awaited<ReturnType<NodeAdapter['node']['getInfo']>>;
}

export class NodesService {
  readonly #db: Db;
  readonly #vault: Vault;
  readonly #log: Logger;
  readonly #dev: boolean;
  readonly #maxNodes: number;
  readonly #factory: AdapterFactory;
  readonly #now: () => Date;
  readonly #adapters = new Map<string, { revision: number; adapter: NodeAdapter }>();
  readonly #listeners = new Set<(id: string) => void>();
  onChange(listener: (id: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #changed(id: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(id);
      } catch {
        this.#log.error('node change listener failed', { nodeId: id });
      }
    }
  }
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

  async prepare(
    input: ManageNodeRequest & { serverName: string },
    requestId: string,
    replacing = false,
  ): Promise<PreparedNode> {
    if (!PROFILES[input.chain].networks.includes(input.network)) {
      throw new AppError('validation_failed', `${PROFILES[input.chain].displayName} has no ${input.network} network.`);
    }
    if (input.credentialBlock !== undefined) {
      if (input.viewRune !== undefined || input.spendRune !== undefined)
        throw new AppError('validation_failed', 'Supply either a credential block or separate credentials.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.credentialBlock);
      } catch {
        throw new AppError('validation_failed', 'Invalid credential block.');
      }
      const result = NodeCredentialBlock.safeParse(parsed);
      if (!result.success) throw new AppError('validation_failed', 'Invalid credential block.');
      if (input.accessLevel !== undefined && input.accessLevel !== result.data.accessLevel)
        throw new AppError('validation_failed', 'Credential block access level does not match.');
      input = { ...input, ...result.data };
    }
    const level = input.accessLevel ?? (input.spendRune === undefined ? 'read-only' : 'standard');
    if (level === 'admin' && input.adminAcknowledged !== true) throw new AppError('permission_denied', ADMIN_WARNING);
    if (input.limits && !limitsAreOrdered(input.limits))
      throw new AppError('validation_failed', 'Spending limits must be ordered.');
    const url = new URL(input.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/'].includes(url.pathname) ||
      input.serverName !== 'localhost' ||
      (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 && !isNodeAddress(url.hostname.replace(/^\[|\]$/g, '')))
    )
      throw new AppError(
        'validation_failed',
        'Use an HTTPS node origin without credentials, query or path, and the localhost TLS name.',
      );
    // regtest chains can be made to look like anything, so they are only for development (and tests).
    if (input.network === 'regtest' && !this.#dev) {
      throw new AppError('validation_failed', 'regtest nodes can only be added in development mode.');
    }
    // Checked here to refuse early, and again in the transaction that adds the node: additions at the same time all
    // pass this one.
    if (!replacing) await this.#refuseAtLimit(this.#db);

    const connection: NodeConnection = {
      url: input.url,
      caCertificate: input.caCertificate,
      serverName: input.serverName,
      viewRune: input.viewRune ?? '',
      ...(input.spendRune === undefined ? {} : { spendRune: input.spendRune }),
    };
    const adapter = this.#factory({
      url: connection.url,
      caCertificate: connection.caCertificate,
      serverName: connection.serverName,
      viewRune: connection.viewRune,
    });
    const scopes = await verifyRunes(adapter, input.viewRune ?? '', input.spendRune, level);
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
    const row: NodeRow = {
      id,
      view_methods: JSON.stringify(scopes.read.methods),
      spend_methods: JSON.stringify(
        scopes.spend?.admin ? nodeMethodsFor(METHODS, 'spend') : (scopes.spend?.methods ?? []),
      ),
      removed_at: null,
      revision: 0,
      access_level: level,
      spend_state: input.spendRune === undefined ? 'missing' : 'ok',
      credentials_checked_at: this.#now().toISOString(),
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
      created_at: this.#now().toISOString(),
    };
    return { input, row, adapter, facts };
  }

  // Setup may call this inside its final transaction. No node call or cache mutation takes place under the lock.
  async storePrepared(trx: Db, prepared: PreparedNode): Promise<void> {
    await this.#refuseAtLimit(trx);
    const { row, input } = prepared;
    const duplicate = await trx
      .selectFrom('nodes')
      .selectAll()
      .where('chain', '=', row.chain)
      .where('network', '=', row.network)
      .where('pubkey', '=', row.pubkey)
      .executeTakeFirst();
    if (duplicate && duplicate.removed_at === null)
      throw new AppError('validation_failed', 'This node has already been added.');
    if (duplicate) {
      row.id = duplicate.id;
      row.created_at = duplicate.created_at;
      row.revision = Number(duplicate.revision) + 1;
      await trx.updateTable('nodes').set(row).where('id', '=', row.id).execute();
    } else await trx.insertInto('nodes').values(row).execute();
    await this.#storeLimits(trx, prepared);
    await this.#vault.put(trx, row.id, 'read', input.viewRune ?? '');
    if (input.spendRune !== undefined) await this.#vault.put(trx, row.id, 'spend', input.spendRune);
  }

  rememberPrepared(prepared: PreparedNode, requestId: string): void {
    const { row, adapter, facts, input } = prepared;
    this.#changed(row.id);
    this.#adapters.set(row.id, { revision: row.revision, adapter });
    this.monitor.recordBaseline(row.id, facts);
    this.#log.info('node added', {
      requestId,
      nodeId: row.id,
      chain: row.chain,
      network: row.network,
      pubkey: facts.pubkey,
      identity: row.identity_state,
      canSpend: input.spendRune !== undefined,
      adminCredential: row.access_level === 'admin',
      security: true,
    });
  }

  async add(
    input: ManageNodeRequest & { serverName: string },
    requestId: string,
    authorize?: (db: Db) => Promise<void>,
    requireLimits = false,
  ): Promise<NodeSummaryData> {
    const prepared = await this.prepare(input, requestId);
    await writeTx(this.#db, async (trx) => {
      // Verification performs RPCs; authorization can expire or be revoked while they are pending.
      await authorize?.(trx);
      await this.storePrepared(trx, prepared);
      if (
        requireLimits &&
        prepared.input.spendRune !== undefined &&
        !(await trx
          .selectFrom('spend_limits')
          .select('chain')
          .where('chain', '=', prepared.row.chain)
          .where('pubkey', '=', prepared.row.pubkey)
          .executeTakeFirst())
      )
        throw new AppError('setup_required', 'Choose Lightning Pilot spending limits when adding this node.', {
          reason: 'spend_policy_missing',
        });
    });
    this.rememberPrepared(prepared, requestId);
    return this.summary(prepared.row.id);
  }

  async #refuseAtLimit(db: Db): Promise<void> {
    const count = await db
      .selectFrom('nodes')
      .where('removed_at', 'is', null)
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= this.#maxNodes)
      throw new AppError('validation_failed', 'The maximum number of nodes is reached.');
  }

  async #row(id: string): Promise<NodeRow> {
    const row = await this.#db
      .selectFrom('nodes')
      .selectAll()
      .where('id', '=', id)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
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
      canSpend: (await this.#canSpend(row.id)) && row.credentials_checked_at !== null && row.spend_state === 'ok',
      accessLevel: row.access_level as AccessLevel,
      adminCredential: row.access_level === 'admin',
      limitsRequired: !(await this.#db
        .selectFrom('spend_limits')
        .select('chain')
        .where('chain', '=', row.chain)
        .where('pubkey', '=', row.pubkey)
        .executeTakeFirst()),
      chainIdentity: identityOfRow(row),
      createdAt: row.created_at,
    };
  }

  async summary(id: string): Promise<NodeSummaryData> {
    return this.#toSummary(await this.#row(id));
  }

  async list(): Promise<NodeSummaryData[]> {
    const rows = await this.#db
      .selectFrom('nodes')
      .selectAll()
      .where('removed_at', 'is', null)
      .orderBy('created_at')
      .execute();
    return Promise.all(rows.map((r) => this.#toSummary(r)));
  }

  // Snapshot the profile and read credential together. A concurrent replacement cannot pair a new secret with
  // an old endpoint, and a late loader cannot make a stale cache entry usable for a later revision.
  async adapter(id: string): Promise<{ row: NodeRow; adapter: NodeAdapter; canSpend: boolean }> {
    const loaded = await writeTx(this.#db, async (db) => {
      const row = await db
        .selectFrom('nodes')
        .selectAll()
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new AppError('not_found', 'No such node.');
      const cached = this.#adapters.get(id);
      if (cached?.revision === row.revision) return { row, adapter: cached.adapter };
      const viewRune = await this.#vault.get(db, id, 'read');
      if (!viewRune) throw new AppError('node_credential_revoked', 'The node has no view credential.');
      // Legacy rows were admitted before scope checks existed; never cache a privileged view secret.
      inspectRune(viewRune, 'read', row.access_level as AccessLevel);
      return {
        row,
        connection: { url: row.url, caCertificate: row.ca_certificate, serverName: row.server_name, viewRune },
      };
    });
    const adapter = 'adapter' in loaded ? loaded.adapter : this.#factory(loaded.connection);
    this.#adapters.set(id, { revision: loaded.row.revision, adapter });
    return {
      row: loaded.row,
      adapter,
      canSpend:
        (await this.#canSpend(id)) && loaded.row.credentials_checked_at !== null && loaded.row.spend_state === 'ok',
    };
  }

  async #storeLimits(db: Db, prepared: PreparedNode): Promise<void> {
    if (!prepared.input.limits) return;
    const p = SpendPolicy.parse(prepared.input.limits);
    await db
      .insertInto('spend_limits')
      .values({
        chain: prepared.row.chain,
        pubkey: prepared.row.pubkey,
        max_per_payment_sat: p.maxPerPayment,
        max_24h_sat: p.max24h,
        step_up_above_sat: p.stepUpAbove,
        max_fee_rate: p.maxFeeRate,
        max_fee_share_percent: p.maxFeeSharePercent,
        max_routing_fee_share_percent: p.maxRoutingFeeSharePercent,
        routing_fee_allowance_sat: p.routingFeeAllowance,
        max_fee_rate_mode: p.maxFeeRateMode,
        max_fee_share_mode: p.maxFeeShareMode,
        max_routing_fee_mode: p.maxRoutingFeeMode,
      })
      .onConflict((oc) => oc.columns(['chain', 'pubkey']).doNothing())
      .execute();
  }

  async #refuseUnresolved(db: Db, id: string, replacing = false): Promise<void> {
    const pending = await db
      .selectFrom('spend_intents')
      .select('id')
      .where('node_id', '=', id)
      .where('state', 'in', replacing ? ['reserved', 'sent'] : ['reserved', 'sent', 'unknown'])
      .executeTakeFirst();
    if (pending)
      throw new AppError('spend_unknown', 'Resolve outstanding spends before changing or removing this node.');
  }

  async replace(
    id: string,
    input: ManageNodeRequest & { serverName: string },
    requestId: string,
    authorize: (db: Db) => Promise<void>,
  ) {
    const previous = await this.#row(id);
    const prepared = await this.prepare(input, requestId, true);
    if (
      prepared.row.chain !== previous.chain ||
      prepared.row.network !== previous.network ||
      prepared.row.pubkey !== previous.pubkey
    )
      throw new AppError(
        'validation_failed',
        'A replacement must have the same node identity. Add a different node instead.',
      );
    prepared.row.id = id;
    prepared.row.created_at = previous.created_at;
    prepared.row.revision = previous.revision + 1;
    await this.monitor.admit(id, async () => {
      await writeTx(this.#db, async (db) => {
        await authorize(db);
        await this.#refuseUnresolved(db, id, true);
        const current = await db.selectFrom('nodes').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
        if (current.removed_at !== null || current.revision !== previous.revision)
          throw new AppError('busy', 'The node changed; retry.');
        await db.updateTable('nodes').set(prepared.row).where('id', '=', id).execute();
        await db.deleteFrom('credentials').where('node_id', '=', id).execute();
        await db.deleteFrom('event_cursors').where('node_id', '=', id).execute();
        await this.#vault.put(db, id, 'read', prepared.input.viewRune ?? '');
        if (prepared.input.spendRune !== undefined) await this.#vault.put(db, id, 'spend', prepared.input.spendRune);
        await this.#storeLimits(db, prepared);
        if (
          prepared.input.spendRune !== undefined &&
          !(await db
            .selectFrom('spend_limits')
            .select('chain')
            .where('chain', '=', prepared.row.chain)
            .where('pubkey', '=', prepared.row.pubkey)
            .executeTakeFirst())
        )
          throw new AppError('setup_required', 'Choose Lightning Pilot spending limits before enabling spending.', {
            reason: 'spend_policy_missing',
          });
      });
      this.#adapters.delete(id);
      this.rememberPrepared(prepared, requestId);
    });
    return this.summary(id);
  }

  async remove(id: string, requestId: string, authorize: (db: Db) => Promise<void>): Promise<void> {
    await this.monitor.admit(id, async () => {
      await writeTx(this.#db, async (db) => {
        await authorize(db);
        await this.#refuseUnresolved(db, id);
        const row = await db
          .selectFrom('nodes')
          .selectAll()
          .where('id', '=', id)
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (!row) throw new AppError('not_found', 'No such node.');
        await db
          .updateTable('nodes')
          .set({ removed_at: this.#now().toISOString(), revision: row.revision + 1 })
          .where('id', '=', id)
          .execute();
        await db.deleteFrom('credentials').where('node_id', '=', id).execute();
        await db.deleteFrom('event_cursors').where('node_id', '=', id).execute();
      });
      this.#adapters.delete(id);
      this.monitor.forget(id);
      this.#changed(id);
    });
    this.#log.warn('node removed', { nodeId: id, requestId, security: true });
  }

  // Only spend callers use this uncached loader, after admission has created a blocking intent.
  async spendingAdapter(id: string): Promise<NodeAdapter> {
    const { row, viewRune, spendRune } = await writeTx(this.#db, async (db) => {
      const row = await db
        .selectFrom('nodes')
        .selectAll()
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new AppError('not_found', 'No such node.');
      const viewRune = await this.#vault.get(db, id, 'read');
      const spendRune = await this.#vault.get(db, id, 'spend');
      if (!viewRune || !spendRune || row.credentials_checked_at === null || row.spend_state !== 'ok')
        throw new AppError('node_credential_revoked', 'Replace and verify the node credentials.');
      return { row, viewRune, spendRune };
    });
    const adapter = this.#factory({
      url: row.url,
      caCertificate: row.ca_certificate,
      serverName: row.server_name,
      viewRune,
      spendRune,
    });
    const rowRevision = row.revision;
    const guarded = { ...adapter };
    // Only actual spend-header refusals change spend status; a view-header refusal says nothing about it.
    for (const row of METHODS.filter((m) => m.credential === 'spend')) {
      const port = guarded[row.port] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = port[row.method];
      if (!original) continue;
      const copy = { ...port };
      copy[row.method] = async (...args) => {
        try {
          return await original(...args);
        } catch (error) {
          if (error instanceof AdapterError && error.code === 'node_credential_revoked')
            await writeTx(this.#db, async (db) => {
              await db
                .updateTable('nodes')
                .set({ spend_state: 'revoked' })
                .where('id', '=', id)
                .where('revision', '=', rowRevision)
                .execute();
            });
          throw error;
        }
      };
      Object.assign(guarded, { [row.port]: copy });
    }
    return guarded;
  }

  // What the stored credentials allow, from their last admission or verification; no node call.
  capabilities(row: NodeRow): Capability[] {
    const read = new Set(JSON.parse(row.view_methods) as string[]);
    const spend = new Set(JSON.parse(row.spend_methods) as string[]);
    return capabilitiesAllowed(
      METHODS,
      (method) =>
        method.nodeMethods.every((m) => (method.credential === 'read' ? read : spend).has(m)) &&
        (method.credential === 'read' || row.spend_state === 'ok'),
    );
  }

  // The read adapter for one read port method, refused with capability_missing when the stored view credential
  // does not allow the method's node commands. Without this check a narrow but valid view rune makes the node
  // answer 1502 over HTTP 401, which reads as a revoked credential. Rows admitted before scopes were stored
  // (unchecked, no methods recorded) are left to the node to enforce.
  async readAdapter(id: string, port: string, method: string): Promise<Awaited<ReturnType<NodesService['adapter']>>> {
    const loaded = await this.adapter(id);
    const row = METHODS.find((m) => m.port === port && m.method === method && m.credential === 'read');
    if (!row) throw new Error(`not a read method: ${port}.${method}`);
    const methods = JSON.parse(loaded.row.view_methods) as string[];
    const unrecorded = methods.length === 0 && loaded.row.credentials_checked_at === null;
    if (!unrecorded && !row.nodeMethods.every((m) => methods.includes(m)))
      throw new AppError('capability_missing', 'The node credential does not allow this.', {
        method: `${port}.${method}`,
      });
    return loaded;
  }

  async credentialStatus(id: string) {
    const { row, adapter } = await this.adapter(id);
    let view: 'ok' | 'revoked' = 'ok';
    try {
      await adapter.node.getInfo();
    } catch (error) {
      if (!(error instanceof AdapterError) || error.code !== 'node_credential_revoked') throw error;
      view = 'revoked';
    }
    const capabilities = view === 'ok' ? this.capabilities(row) : [];
    return {
      credentials: {
        view,
        spend: row.credentials_checked_at === null ? 'unknown' : (row.spend_state as 'ok' | 'revoked' | 'missing'),
      },
      accessLevel: row.access_level,
      adminCredential: row.access_level === 'admin',
      capabilities,
      checkedAt: row.credentials_checked_at,
      spendStatusSource: 'last-verification',
    };
  }

  async recheckCredentials(id: string, requestId: string, authorize: (db: Db) => Promise<void>) {
    const { row, view, spend } = await writeTx(this.#db, async (db) => {
      const row = await db
        .selectFrom('nodes')
        .selectAll()
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new AppError('not_found', 'No such node.');
      const view = await this.#vault.get(db, id, 'read');
      const spend = await this.#vault.get(db, id, 'spend');
      return { row, view, spend };
    });
    const adapter = this.#factory({
      url: row.url,
      caCertificate: row.ca_certificate,
      serverName: row.server_name,
      viewRune: view ?? '',
    });
    let scopes;
    try {
      scopes = await verifyRunes(adapter, view ?? '', spend, row.access_level as AccessLevel);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === 'node_credential_revoked' &&
        (error.details as { credential?: string } | undefined)?.credential === 'spend'
      )
        await writeTx(this.#db, async (db) => {
          await authorize(db);
          await db
            .updateTable('nodes')
            .set({ spend_state: 'revoked' })
            .where('id', '=', id)
            .where('revision', '=', row.revision)
            .execute();
        });
      throw error;
    }
    await writeTx(this.#db, async (db) => {
      await authorize(db);
      const current = await db.selectFrom('nodes').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      if (current.removed_at !== null || current.revision !== row.revision)
        throw new AppError('busy', 'The node changed; retry.');
      await db
        .updateTable('nodes')
        .set({
          view_methods: JSON.stringify(scopes.read.methods),
          spend_methods: JSON.stringify(
            scopes.spend?.admin ? nodeMethodsFor(METHODS, 'spend') : (scopes.spend?.methods ?? []),
          ),
          credentials_checked_at: this.#now().toISOString(),
          spend_state: spend === undefined ? 'missing' : 'ok',
        })
        .where('id', '=', id)
        .execute();
    });
    this.#log.warn('node credentials checked', { nodeId: id, requestId, security: true });
    return this.credentialStatus(id);
  }

  identity(row: NodeRow): ChainIdentityState {
    return identityOfRow(row);
  }
}
