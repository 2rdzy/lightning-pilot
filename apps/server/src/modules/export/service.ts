import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { isExportableViewRune } from '@lightning-pilot/adapter-cln';
import { PROFILES } from '@lightning-pilot/chain';
import {
  AppError,
  ExportPayload,
  ExportRequest,
  ImportRequest,
  SessionPolicy,
  SetupAlerts,
  EXPORT_PLAINTEXT_BYTES,
  EXPORT_RECORD_LIMITS,
  type ExportEnvelope,
} from '@lightning-pilot/core';
import type { Db } from '../../storage/db.ts';
import type { Logger } from '../../logging/logger.ts';
import type { Vault } from '../vault/index.ts';
import type { AuthService } from '../auth/index.ts';
import { loadPolicy, policyValues } from '../spend/index.ts';
import { encryptExport, decryptExport, invalidExport } from './crypto.ts';

const DAY = 86400000;
export const IMPORT_WARNINGS = [
  'Spend credentials must be entered again. Imported nodes must pass their chain check and spending reconciliation.',
  'Retire the source instance before spending from its replacement; budgets are not coordinated between instances.',
  'Unresolved on-chain spends without a PSBT may need node inspection and manual resolution.',
];
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidExport();
  }
}
function preflight(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidExport();
  const payload = value as Record<string, unknown>;
  for (const [name, limit] of Object.entries(EXPORT_RECORD_LIMITS)) {
    const collection = payload[name];
    if (!Array.isArray(collection) || collection.length > limit) throw invalidExport();
  }
  const settings = payload.settings;
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return;
  const alerts = (settings as Record<string, unknown>).alerts;
  if (typeof alerts !== 'object' || alerts === null || Array.isArray(alerts)) return;
  const relays = (alerts as Record<string, unknown>).relays;
  if (Array.isArray(relays) && relays.length > 5) throw invalidExport();
}
interface Options {
  db: Db;
  vault: Vault;
  auth: AuthService;
  logger: Logger;
  dev: boolean;
  maxNodes: number;
  now?: () => Date;
  onImported?: (ids: string[]) => void;
}
const conflict = () =>
  new AppError('validation_failed', 'The import conflicts with destination data. Nothing was imported.');
export class ExportService {
  readonly #o: Options;
  readonly #now: () => Date;
  #active: Promise<void> | undefined;
  #closed = false;
  constructor(options: Options) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
  }
  // Reserve before buffering an upload, not just before the expensive derivation.
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#active)
      throw new AppError('busy', 'Export/import is busy. Try again shortly.', { retryAfter: 1 });
    let done: () => void = () => {};
    this.#active = new Promise((resolve) => {
      done = resolve;
    });
    try {
      return await fn();
    } finally {
      done();
      this.#active = undefined;
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#active;
  }
  async export(idHash: string, input: unknown, requestId = 'r-export'): Promise<ExportEnvelope> {
    await this.#o.auth.requireStepUp(idHash, 'security');
    const audit = await this.#o.auth.sessions.live(this.#o.db, idHash);
    const parsed = ExportRequest.safeParse(input);
    if (!parsed.success) throw invalidExport();
    const request = parsed.data;
    const payload = await this.#o.auth.sessions.authorized(idHash, 'security', async (db) => {
      const rows = await db
        .selectFrom('nodes')
        .selectAll()
        .orderBy('id')
        .limit(EXPORT_RECORD_LIMITS.nodes + 1)
        .execute();
      const nodes: ExportPayload['nodes'] = [];
      for (const row of rows) {
        const rune = request.includeViewCredentials ? await this.#o.vault.get(db, row.id, 'read') : undefined;
        if (rune !== undefined && !isExportableViewRune(rune))
          throw new AppError(
            'validation_failed',
            'A view credential has an unsupported or unsafe scope. Export without credentials.',
          );
        nodes.push({
          id: row.id,
          name: row.name,
          chain: row.chain as 'bitcoin' | 'blake2b',
          network: row.network as 'mainnet' | 'testnet4' | 'signet' | 'regtest',
          implementation: row.implementation as 'cln',
          url: row.url,
          caCertificate: row.ca_certificate,
          serverName: row.server_name,
          pubkey: row.pubkey,
          createdAt: row.created_at,
          ...(row.removed_at === null ? {} : { removedAt: row.removed_at }),
          ...(rune === undefined ? {} : { viewRune: rune }),
        });
      }
      const policies: ExportPayload['policies'] = [];
      for (const p of await db
        .selectFrom('spend_limits')
        .select(['chain', 'pubkey'])
        .orderBy('chain')
        .orderBy('pubkey')
        .limit(EXPORT_RECORD_LIMITS.policies + 1)
        .execute())
        policies.push({ chain: p.chain as 'bitcoin' | 'blake2b', pubkey: p.pubkey, policy: await loadPolicy(db, p) });
      const intents = await db
        .selectFrom('spend_intents')
        .select([
          'id',
          'node_id',
          'chain',
          'pubkey',
          'type',
          'payment_hash',
          'amount_msat',
          'max_fee_msat',
          'fee_msat',
          'cost_msat',
          'destination',
          'state',
          'idempotency_key',
          'digest',
          'session_handle',
          'confirmation_hash',
          'txid',
          'channel_id',
          'peer',
          'close_force',
          'error_code',
          'created_at',
          'updated_at',
        ])
        .orderBy('id')
        .limit(EXPORT_RECORD_LIMITS.intents + 1)
        .execute();
      const counts = await db
        .selectFrom('restore_counts')
        .select(['chain', 'pubkey', 'counted_msat', 'until'])
        .where('state', '=', 'counted')
        .where('until', '>', this.#now().toISOString())
        .limit(EXPORT_RECORD_LIMITS.restoreCounts + 1)
        .execute();
      const settings: ExportPayload['settings'] = {};
      for (const setting of await db
        .selectFrom('settings')
        .selectAll()
        .where('key', 'in', ['session_policy', 'setup_alerts'])
        .execute()) {
        if (setting.key === 'session_policy') settings.sessionPolicy = SessionPolicy.parse(parseJson(setting.value));
        else {
          const alerts = SetupAlerts.safeParse(parseJson(setting.value));
          if (alerts.success && alerts.data.kind !== 'telegram') settings.alerts = alerts.data;
        }
      }
      const data = ExportPayload.safeParse({
        version: 1,
        createdAt: this.#now().toISOString(),
        includesViewCredentials: request.includeViewCredentials,
        settings,
        nodes,
        policies,
        intents,
        restoreCounts: counts.map((c) => ({
          chain: c.chain,
          pubkey: c.pubkey,
          countedMsat: c.counted_msat,
          until: c.until,
        })),
      });
      if (!data.success)
        throw new AppError('validation_failed', 'The stored data exceeds the supported export format or limits.');
      this.#validate(data.data);
      return data.data;
    });
    const plain = Buffer.from(JSON.stringify(payload), 'utf8');
    try {
      if (plain.length > EXPORT_PLAINTEXT_BYTES) throw invalidExport();
      const envelope = await encryptExport(plain, request.passphrase);
      await this.#o.auth.requireStepUp(idHash, 'security');
      this.#o.logger.info('encrypted export created', {
        requestId,
        sessionHandle: audit.handle,
        security: true,
        nodes: payload.nodes.length,
        intents: payload.intents.length,
      });
      return envelope;
    } finally {
      plain.fill(0);
    }
  }
  async import(idHash: string, input: unknown, requestId = 'r-import') {
    await this.#o.auth.requireStepUp(idHash, 'security');
    const audit = await this.#o.auth.sessions.live(this.#o.db, idHash);
    const request = ImportRequest.safeParse(input);
    if (!request.success) throw invalidExport();
    const plain = await decryptExport(request.data.envelope, request.data.passphrase);
    let data: ExportPayload;
    try {
      // Fatal UTF-8 decoding prevents ambiguous replacement of malformed byte sequences.
      const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
      const value: unknown = JSON.parse(text);
      preflight(value);
      data = ExportPayload.parse(value);
      this.#validate(data);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw invalidExport();
    } finally {
      plain.fill(0);
    }
    await this.#o.auth.sessions.authorized(idHash, 'security', async (db) => {
      const existing = await db.selectFrom('nodes').where('removed_at', 'is', null).select('id').execute();
      if (existing.length + data.nodes.filter((n) => n.removedAt === undefined).length > this.#o.maxNodes)
        throw conflict();
      for (const node of data.nodes) {
        if (
          await db
            .selectFrom('nodes')
            .select('id')
            .where((eb) =>
              eb.or([
                eb('id', '=', node.id),
                eb.and([
                  eb('chain', '=', node.chain),
                  eb('network', '=', node.network),
                  eb('pubkey', '=', node.pubkey),
                ]),
              ]),
            )
            .executeTakeFirst()
        )
          throw conflict();
      }
      for (const p of data.policies)
        if (
          await db
            .selectFrom('spend_limits')
            .select('chain')
            .where('chain', '=', p.chain)
            .where('pubkey', '=', p.pubkey)
            .executeTakeFirst()
        )
          throw conflict();
      for (const i of data.intents)
        if (
          await db
            .selectFrom('spend_intents')
            .select('id')
            .where((eb) => eb.or([eb('id', '=', i.id), eb('idempotency_key', '=', i.idempotency_key)]))
            .executeTakeFirst()
        )
          throw conflict();
      const settings = [
        ['session_policy', data.settings.sessionPolicy],
        ['setup_alerts', data.settings.alerts],
      ] as const;
      for (const [key, value] of settings) {
        if (value === undefined) continue;
        const old = await db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
        if (old) {
          const validated =
            key === 'session_policy'
              ? SessionPolicy.safeParse(parseJson(old.value))
              : SetupAlerts.safeParse(parseJson(old.value));
          if (!validated.success || JSON.stringify(validated.data) !== JSON.stringify(value)) throw conflict();
        } else
          await db
            .insertInto('settings')
            .values({ key, value: JSON.stringify(value) })
            .execute();
      }
      const at = this.#now().toISOString();
      for (const n of data.nodes) {
        await db
          .insertInto('nodes')
          .values({
            id: n.id,
            removed_at: n.removedAt ?? null,
            access_level: 'read-only',
            name: n.name,
            chain: n.chain,
            network: n.network,
            implementation: n.implementation,
            url: n.url,
            ca_certificate: n.caCertificate,
            server_name: n.serverName,
            pubkey: n.pubkey,
            created_at: n.createdAt,
            identity_state: 'waiting',
            identity_failed_check: null,
            identity_detail: 'Imported node: credentials and identity check required.',
            identity_checked_at: at,
          })
          .execute();
        if (n.viewRune !== undefined) await this.#o.vault.put(db, n.id, 'read', n.viewRune);
      }
      for (const p of data.policies)
        await db
          .insertInto('spend_limits')
          .values({ chain: p.chain, pubkey: p.pubkey, ...policyValues(p.policy) })
          .execute();
      for (const i of data.intents)
        await db
          .insertInto('spend_intents')
          .values({
            ...i,
            state: i.state === 'reserved' || i.state === 'sent' ? 'unknown' : i.state,
            preimage: null,
            psbt_key_id: null,
            psbt_nonce: null,
            psbt_ciphertext: null,
          })
          .execute();
      // The source's restore counts are validated but not stored: the import's own restore row below makes every
      // identity count the last 24 hours from its node, which covers what they counted (spend policy §15 item 4).
      const id = await this.#restore(db, at, data.createdAt);
      for (const identity of await db.selectFrom('nodes').select(['chain', 'pubkey']).distinct().execute())
        await db
          .insertInto('restore_counts')
          .values({
            restore_id: id,
            ...identity,
            state: 'pending',
            counted_msat: null,
            counted_at: null,
            until: new Date(Date.parse(at) + DAY).toISOString(),
          })
          .execute();
    });
    // There can only be one import; settings collisions prohibit changing an existing policy.
    if (data.settings.sessionPolicy !== undefined) await this.#o.auth.sessions.reloadPolicy();
    this.#o.onImported?.(data.nodes.map((n) => n.id));
    this.#o.logger.warn('encrypted export imported', {
      requestId,
      sessionHandle: audit.handle,
      security: true,
      nodes: data.nodes.length,
      intents: data.intents.length,
    });
    return {
      nodes: data.nodes.length,
      policies: data.policies.length,
      intents: data.intents.length,
      warnings: [...IMPORT_WARNINGS],
    };
  }
  async #restore(db: Db, at: string, snapshot: string) {
    const id = randomUUID();
    await db
      .insertInto('restores')
      .values({
        id,
        marker_hash: createHash('sha256').update(id).digest('hex'),
        restored_at: snapshot,
        backup_file: 'encrypted-export',
        recorded_at: at,
      })
      .execute();
    return id;
  }
  #validate(data: ExportPayload) {
    const unique = (values: string[]) => {
      if (new Set(values).size !== values.length) throw invalidExport();
    };
    const snapshot = Date.parse(data.createdAt);
    const wall = this.#now().getTime();
    if (snapshot > wall + 300000) throw invalidExport();
    unique(data.nodes.map((n) => n.id));
    unique(data.nodes.map((n) => `${n.chain}|${n.network}|${n.pubkey}`));
    unique(data.policies.map((p) => `${p.chain}|${p.pubkey}`));
    unique(data.intents.map((i) => i.id));
    unique(data.intents.map((i) => i.idempotency_key));
    for (const n of data.nodes) {
      try {
        new X509Certificate(n.caCertificate);
      } catch {
        throw invalidExport();
      }
      const url = new URL(n.url);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (!this.#o.dev && n.network === 'regtest') ||
        !PROFILES[n.chain].networks.includes(n.network)
      )
        throw invalidExport();
      if (Date.parse(n.createdAt) > snapshot || (n.viewRune !== undefined && !isExportableViewRune(n.viewRune)))
        throw invalidExport();
    }
    for (const n of data.nodes) n.createdAt = new Date(n.createdAt).toISOString();
    const nodes = new Map(data.nodes.map((n) => [n.id, n]));
    for (const i of data.intents) {
      // A future ledger time is excluded by rolling-budget queries, yet reconciliation already knows its hash.
      // Wait for wall time instead of allowing both budget components to omit the same spend.
      if (Date.parse(i.created_at) > wall)
        throw new AppError(
          'validation_failed',
          'The export has future-dated spends. Check the destination clock and try again after it catches up.',
          { reason: 'future_spend_time' },
        );
      const n = nodes.get(i.node_id);
      if (
        !n ||
        i.chain !== n.chain ||
        i.pubkey !== n.pubkey ||
        Date.parse(i.created_at) > snapshot ||
        Date.parse(i.updated_at) > snapshot ||
        Date.parse(i.updated_at) < Date.parse(i.created_at)
      )
        throw invalidExport();
    }
    for (const i of data.intents) {
      i.created_at = new Date(i.created_at).toISOString();
      i.updated_at = new Date(i.updated_at).toISOString();
    }
    for (const c of data.restoreCounts) {
      if (Date.parse(c.until) > snapshot + DAY) throw invalidExport();
      c.until = new Date(c.until).toISOString();
    }
    data.createdAt = new Date(data.createdAt).toISOString();
  }
}
