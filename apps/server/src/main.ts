// Entry point: lightning-pilot [--config <path>] [--dev]. Any configuration or vault problem stops start-up with a
// clear message and a non-zero exit code.
import { readFileSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import { serve } from '@hono/node-server';
import { ConfigError, loadConfig } from './config/config.ts';
import { createLogger } from './logging/logger.ts';
import { VaultError } from './modules/vault/index.ts';
import { buildServer } from './server.ts';

async function main(): Promise<void> {
  const { config, vaultKeyPath, dev } = loadConfig({ argv: process.argv.slice(2), env: process.env });
  const logger = createLogger({ level: config.log.level, modules: config.log.modules });
  // The effective configuration holds no secrets, so it is logged as a whole.
  logger.info('starting', { config, dev });
  const server = await buildServer({ config, vaultKeyPath, dev, logger });

  const tls =
    config.tls.mode === 'files' && config.tls.certFile && config.tls.keyFile
      ? { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) }
      : undefined;
  serve(
    {
      fetch: server.app.fetch,
      hostname: config.server.listen,
      port: config.server.port,
      ...(tls ? { createServer: createSecureServer, serverOptions: { ...tls, allowHTTP1: true } } : {}),
    },
    (info) => logger.info('listening', { address: info.address, port: info.port, tls: config.tls.mode }),
  );
  const stop = () => {
    logger.info('stopping');
    void server.close().finally(() => process.exit(0));
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
