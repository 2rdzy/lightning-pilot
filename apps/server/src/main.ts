// Entry point: lightning-pilot [--config <path>] [--dev]. Any configuration or vault problem stops start-up with a
// clear message and a non-zero exit code.
import { existsSync, mkdirSync } from 'node:fs';
import { acquireServiceLock, requireDataOwner, resetAuth } from './modules/setup/reset.ts';
import { fileURLToPath } from 'node:url';
import { parseCommand } from './config/cli.ts';
import { inspectTls } from './config/tls.ts';
import { ConfigError, loadConfig } from './config/config.ts';
import { listen } from './http/listen.ts';
import { fatalError } from './logging/fatal.ts';
import { redactString } from './logging/redact.ts';
import { createLogger } from './logging/logger.ts';
import { finishVaultChange, loadVaultKey, resetVault, Vault, VaultError } from './modules/vault/index.ts';
import { resetLoginThrottles } from './modules/auth/index.ts';
import { kyselyOf, openRaw } from './storage/db.ts';
import { migrate } from './storage/migrate.ts';
import { join } from 'node:path';
import { buildServer } from './server.ts';

async function main(): Promise<void> {
  const { command, args, newKeyFile } = parseCommand(process.argv.slice(2));
  const reset = command === 'reset-auth';
  const tokenOnly = command === 'setup-token';
  const throttleReset = command === 'reset-login-throttles';
  const offlineVault = command.startsWith('vault-');
  const { config, vaultKeyPath, dev } = loadConfig({
    argv: args,
    env: process.env,
    checkOnly: command === 'config-check' || command === 'vault-reset',
  });
  if (command === 'config-check') {
    process.stdout.write('configuration valid\n');
    return;
  }
  if (reset || tokenOnly || throttleReset || offlineVault) requireDataOwner(config.paths.dataDir);
  mkdirSync(config.paths.dataDir, { recursive: true, mode: 0o700 });
  const release = acquireServiceLock(config.paths.dataDir);
  process.once('exit', release);
  const logger = createLogger({ ...config.log, directory: config.paths.logDir });
  process.once('uncaughtException', (err) => fatalError(logger, err));
  process.once('unhandledRejection', (err: unknown) => fatalError(logger, err));
  if (offlineVault) {
    const newKey = loadVaultKey(newKeyFile ?? `${vaultKeyPath}.new`);
    let oldKey: Buffer | undefined;
    try {
      if (command === 'vault-rotate') oldKey = loadVaultKey(vaultKeyPath);
      const raw = await openRaw(join(config.paths.dataDir, 'lightning-pilot.db'));
      const db = kyselyOf(raw);
      try {
        migrate(raw, undefined, { dir: join(config.paths.dataDir, 'backups') });
        if (command === 'vault-rotate' && oldKey)
          logger.child('vault').warn('vault rotated', { ...(await Vault.rotate(db, oldKey, newKey)), security: true });
        else logger.child('vault').warn('vault reset', { keyId: await resetVault(db, newKey), security: true });
        finishVaultChange(raw, config.paths.dataDir, logger);
      } finally {
        await db.destroy();
      }
    } finally {
      oldKey?.fill(0);
      newKey.fill(0);
    }
    if (command === 'vault-reset') {
      logger.warn('install and back up the new key file before restarting the service');
      const server = await buildServer({ config, vaultKeyPath: newKeyFile ?? '', dev, logger });
      await server.close();
    } else logger.warn('finish key-file rotation and back up the new key file; retain the old key for older backups');
    return;
  }
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
  const tlsCertificate = reset || tokenOnly ? undefined : inspectTls(config, logger, dev);
  const server = await buildServer({
    ...(tlsCertificate ? { tlsCertificate } : {}),
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
  if (!known)
    process.stderr.write(`${redactString(err instanceof Error ? (err.stack ?? err.message) : String(err))}\n`);
  process.exit(1);
});
