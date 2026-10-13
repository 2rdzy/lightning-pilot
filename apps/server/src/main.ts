// Entry point: lightning-pilot [--config <path>] [--dev]. Any configuration or vault problem stops start-up with a
// clear message and a non-zero exit code.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config/config.ts';
import { listen } from './http/listen.ts';
import { createLogger } from './logging/logger.ts';
import { VaultError } from './modules/vault/index.ts';
import { buildServer } from './server.ts';

async function main(): Promise<void> {
  const { config, vaultKeyPath, dev } = loadConfig({ argv: process.argv.slice(2), env: process.env });
  const logger = createLogger({ level: config.log.level, modules: config.log.modules });
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
    ...(existsSync(webRoot) ? { webRoot } : {}),
  });

  const listener = listen(server.app, config, logger);
  // Chain identity of every node now, then on every new block (identity monitor).
  server.nodes.monitor.start();
  const stop = () => {
    logger.info('stopping');
    void listener
      .close()
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
