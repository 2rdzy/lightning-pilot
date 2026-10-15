// Entry point: lightning-pilot [--config <path>] [--dev]. Any configuration or vault problem stops start-up with a
// clear message and a non-zero exit code.
import { existsSync, mkdirSync } from 'node:fs';
import { acquireServiceLock, requireDataOwner, resetAuth } from './modules/setup/reset.ts';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config/config.ts';
import { listen } from './http/listen.ts';
import { createLogger } from './logging/logger.ts';
import { VaultError } from './modules/vault/index.ts';
import { resetLoginThrottles } from './modules/auth/index.ts';
import { kyselyOf, openRaw } from './storage/db.ts';
import { migrate } from './storage/migrate.ts';
import { join } from 'node:path';
import { buildServer } from './server.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const reset = argv[0] === 'reset-auth';
  const tokenOnly = argv[0] === 'setup-token';
  const throttleReset = argv[0] === 'reset-login-throttles';
  const { config, vaultKeyPath, dev } = loadConfig({
    argv: reset || tokenOnly || throttleReset ? argv.slice(1) : argv,
    env: process.env,
  });
  if (reset || tokenOnly || throttleReset) requireDataOwner(config.paths.dataDir);
  mkdirSync(config.paths.dataDir, { recursive: true, mode: 0o700 });
  const release = acquireServiceLock(config.paths.dataDir);
  process.once('exit', release);
  const logger = createLogger({ level: config.log.level, modules: config.log.modules });
  if (throttleReset) {
    const raw = await openRaw(join(config.paths.dataDir, 'lightning-pilot.db'));
    migrate(raw, undefined, { dir: join(config.paths.dataDir, 'backups') });
    const db = kyselyOf(raw);
    try {
      await resetLoginThrottles(db, logger);
    } finally {
      await db.destroy();
    }
    return;
  }
  // The effective configuration holds no secrets, so it is logged as a whole.
  logger.info('starting', { config, dev });
  // The web app built next to the server (pnpm build in apps/web); packaging may move it (WP21).
  const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (!existsSync(webRoot)) logger.warn('web app not built: serving the API only', { webRoot });
  const server = await buildServer({
    config,
    vaultKeyPath,
    dev,
    logger,
    issueSetupToken: !(reset || tokenOnly),
    ...(existsSync(webRoot) ? { webRoot } : {}),
  });

  if (tokenOnly) {
    if (!server.auth.setupMode) {
      await server.close();
      throw new Error('Setup has already been completed.');
    }
    await server.auth.issueSetupToken();
    await server.close();
    return;
  }
  if (reset) {
    await resetAuth(server.db, logger);
    server.setup.close();
    await server.auth.resetState();
    await server.close();
    return;
  }
  const listener = listen(server.app, config, logger);
  // Chain identity of every node now, then on every new block (identity monitor).
  server.nodes.monitor.start();
  // Interrupted spends are read from their nodes in the background.
  server.recovery.start();
  server.events.workers.start();
  const stop = () => {
    logger.info('stopping');
    // Reject queued logins immediately, while keeping storage open until running HTTP requests drain.
    const authClosed = server.auth.close();
    void listener
      .close()
      .then(() => authClosed)
      .then(() => server.close())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  const known = err instanceof ConfigError || err instanceof VaultError;
  process.stderr.write(`lightning-pilot: ${known ? (err as Error).message : 'start-up failed'}\n`);
  if (!known) process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
