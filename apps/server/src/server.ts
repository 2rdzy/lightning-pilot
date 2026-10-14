// Wiring: open the database, run migrations, check the vault key, build the services and the app. Used by main.ts
// and by the end-to-end tests, so both start the server the same way.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { kyselyOf, openRaw, type Db, type Driver } from './storage/db.ts';
import { migrate } from './storage/migrate.ts';
import { createApp } from './http/app.ts';
import type { Router } from './http/context.ts';
import type { Logger } from './logging/logger.ts';
import { AuthService, type ScryptCost } from './modules/auth/index.ts';
import { NodesService, type AdapterFactory } from './modules/nodes/index.ts';
import { SetupService } from './modules/setup/index.ts';
import { ChainSpends, SpendRecovery, SpendService } from './modules/spend/index.ts';
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
  close(): Promise<void>;
}

export async function buildServer(options: ServerOptions): Promise<Server> {
  const { config, logger } = options;
  // The vault key is checked before anything else, so a missing or malformed key stops start-up at once.
  const key = loadVaultKey(options.vaultKeyPath);
  mkdirSync(config.paths.dataDir, { recursive: true, mode: 0o700 });
  const raw = await openRaw(join(config.paths.dataDir, 'lightning-pilot.db'), options.driver);
  const applied = migrate(raw);
  if (applied.length > 0) logger.info('migrations applied', { count: applied.length });
  const db = kyselyOf(raw);
  const vault = await Vault.start(db, key);
  key.fill(0);

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
  const nodes = new NodesService({
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
  // Before any request: intents a stopped process left reserved may have reached the node (spend policy §4).
  const recovery = new SpendRecovery({ db, nodes, logger, ...(options.now ? { now: options.now } : {}) });
  await recovery.markUnresolved();
  const setup = new SetupService({
    db,
    vault,
    auth,
    nodes,
    logger,
    ...(options.scryptCost ? { scryptCost: options.scryptCost } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const app = createApp({
    setup,
    auth,
    nodes,
    spend,
    chainSpends,
    logger,
    hosts: config.server.hosts,
    loginTransport: options.loginTransport ?? 'direct',
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
  });
  logger.info('vault opened', { keyId: vault.keyId, initialised: vault.initialised });
  if (options.issueSetupToken !== false) await auth.issueSetupToken();
  const close = async () => {
    await recovery.stop();
    spend.close();
    chainSpends.close();
    setup.close();
    await auth.close();
    await nodes.monitor.stop();
    await db.destroy();
    vault.close();
  };
  return { app, db, auth, nodes, setup, recovery, close };
}
