// Wiring: open the database, run migrations, check the vault key, build the services and the app. Used by main.ts
// and by the end-to-end tests, so both start the server the same way.
import type { SetupProgress } from '@lightning-pilot/core';
import { Housekeeping } from './modules/jobs/index.ts';
import { EventBus, EventStreams, EventWorkers } from './modules/events/index.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { kyselyOf, openRaw, type Db, type Driver } from './storage/db.ts';
import { migrate } from './storage/migrate.ts';
import { consumeRestoreMarker } from './modules/restore/index.ts';
import { createApp } from './http/app.ts';
import type { Router } from './http/context.ts';
import type { Logger } from './logging/logger.ts';
import { AuthService, type ScryptCost } from './modules/auth/index.ts';
import { NodesService, type AdapterFactory } from './modules/nodes/index.ts';
import { SetupService } from './modules/setup/index.ts';
import { ChainSpends, SpendRecovery, SpendResolution, SpendService } from './modules/spend/index.ts';
import { loadVaultKey, Vault } from './modules/vault/index.ts';
import type { Config } from './config/config.ts';

export interface ServerOptions {
  config: Config;
  vaultKeyPath: string;
  dev: boolean;
  logger: Logger;
  driver?: Driver;
  adapterFactory?: AdapterFactory;
  scryptCost?: ScryptCost;
  now?: () => Date;
  // Directory of the built web app, served for every non-API GET; omitted, the server answers the API only.
  webRoot?: string;
  // Chain identity polling interval (ms); tests set it short.
  identityIntervalMs?: number;
  issueSetupToken?: boolean;
  tlsCertificate?: SetupProgress['tlsCertificate'];
  eventIntervalMs?: number;
  eventHeartbeatMs?: number;
  eventRetryMs?: number;
  // Trusted listener property for the future separate onion listener, never read from a client header.
  loginTransport?: 'direct' | 'tor';
}

export interface Server {
  app: Router;
  db: Db;
  auth: AuthService;
  nodes: NodesService;
  setup: SetupService;
  // Resolves interrupted spends against their nodes; start it once the listener is open (main.ts).
  recovery: SpendRecovery;
  jobs: Housekeeping;
  events: { bus: EventBus; streams: EventStreams; workers: EventWorkers };
  close(): Promise<void>;
}

export async function buildServer(options: ServerOptions): Promise<Server> {
  const { config, logger } = options;
  // The vault key is checked before anything else, so a missing or malformed key stops start-up at once.
  const key = loadVaultKey(options.vaultKeyPath);
  mkdirSync(config.paths.dataDir, { recursive: true, mode: 0o700 });
  const raw = await openRaw(join(config.paths.dataDir, 'lightning-pilot.db'), options.driver);
  const applied = migrate(raw, undefined, {
    dir: join(config.paths.dataDir, 'backups'),
    ...(options.now ? { now: options.now } : {}),
  });
  if (applied.length > 0) logger.info('migrations applied', { count: applied.length });
  const db = kyselyOf(raw);
  // Before any other module reads the database: a restore revokes sessions and pauses spending until reconciled.
  await consumeRestoreMarker(db, config.paths.dataDir, logger, options.now);
  let vault: Vault;
  try {
    vault = await Vault.start(db, key);
  } catch (err) {
    await db.destroy();
    throw err;
  } finally {
    key.fill(0);
  }

  const port = config.server.port === 443 ? '' : `:${config.server.port}`;
  const scheme = config.tls.mode === 'off' ? 'http' : 'https';
  const setupUrl = `${scheme}://${config.server.hosts[0] ?? 'localhost'}${port}/setup`;
  const auth = await AuthService.create({
    db,
    raw,
    trustedProxies: config.server.trustedProxies,
    vault,
    logger,
    setupUrl,
    ...(options.scryptCost ? { scryptCost: options.scryptCost } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const jobs = new Housekeeping({ db, auth, logger, ...(options.now ? { now: options.now } : {}) });
  await jobs.run();
  jobs.start();
  const bus = new EventBus(options.now);
  const nodes = new NodesService({
    onIdentityUpdate: (update) => {
      bus.publish('chain_identity.updated', update.state, update.node);
    },
    db,
    vault,
    logger,
    dev: options.dev,
    maxNodes: config.limits.maxNodes,
    ...(options.adapterFactory ? { adapterFactory: options.adapterFactory } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.identityIntervalMs === undefined ? {} : { identityIntervalMs: options.identityIntervalMs }),
  });
  const spend = new SpendService({ db, nodes, auth, logger, ...(options.now ? { now: options.now } : {}) });
  const chainSpends = new ChainSpends({
    db,
    nodes,
    auth,
    vault,
    logger,
    ...(options.now ? { now: options.now } : {}),
  });
  const spendResolution = new SpendResolution({
    db,
    nodes,
    auth,
    vault,
    logger,
    ...(options.now ? { now: options.now } : {}),
  });
  // Before any request: intents a stopped process left reserved may have reached the node (spend policy §4).
  const recovery = new SpendRecovery({ db, nodes, vault, logger, ...(options.now ? { now: options.now } : {}) });
  await recovery.markUnresolved();
  const streams = new EventStreams(auth, bus, options.eventHeartbeatMs);
  const workers = new EventWorkers({
    db,
    nodes,
    bus,
    logger: logger.child('events'),
    wakeRecovery: (id, hash) => recovery.wake(id, hash),
    ...(options.eventIntervalMs === undefined ? {} : { intervalMs: options.eventIntervalMs }),
    ...(options.eventRetryMs === undefined ? {} : { retryMs: options.eventRetryMs }),
  });
  const events = { bus, streams, workers };
  const setup = new SetupService({
    ...(options.tlsCertificate ? { tlsCertificate: options.tlsCertificate } : {}),
    db,
    vault,
    auth,
    nodes,
    logger,
    ...(options.scryptCost ? { scryptCost: options.scryptCost } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const app = createApp({
    streams,
    setup,
    auth,
    nodes,
    spend,
    chainSpends,
    spendResolution,
    logger,
    hosts: config.server.hosts,
    loginTransport: options.loginTransport ?? 'direct',
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
  });
  logger.info('vault opened', { keyId: vault.keyId, initialised: vault.initialised });
  if (options.issueSetupToken !== false) await auth.issueSetupToken();
  const close = async () => {
    await jobs.stop();
    await streams.stop();
    await workers.stop();
    await recovery.stop();
    spend.close();
    chainSpends.close();
    setup.close();
    await auth.close();
    await nodes.monitor.stop();
    await db.destroy();
    vault.close();
  };
  return { app, db, auth, nodes, setup, recovery, jobs, events, close };
}
