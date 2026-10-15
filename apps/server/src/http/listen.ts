// Starts the HTTP(S) listener for a built server: TLS from files (HTTP/2 with HTTP/1.1 fallback) or plain HTTP on
// loopback (tls.mode "off", refused elsewhere by the config loader). Used by main.ts and the development server.
import { tlsPaths } from '../config/tls.ts';
import { readFileSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Config } from '../config/config.ts';
import type { Logger } from '../logging/logger.ts';
import type { Router } from './context.ts';

export interface Listener {
  // The port actually bound (useful with port 0 in tests).
  port: Promise<number>;
  close(): Promise<void>;
}

export function listen(app: Pick<Router, 'fetch'>, config: Config, logger: Logger): Listener {
  const paths = config.tls.mode === 'off' ? undefined : tlsPaths(config);
  const tls = paths ? { cert: readFileSync(paths.certFile), key: readFileSync(paths.keyFile) } : undefined;
  let bound: (port: number) => void = () => undefined;
  const port = new Promise<number>((resolve) => (bound = resolve));
  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.server.listen,
      port: config.server.port,
      ...(tls ? { createServer: createSecureServer, serverOptions: { ...tls, allowHTTP1: true } } : {}),
    },
    (info: AddressInfo) => {
      logger.info('listening', { address: info.address, port: info.port, tls: config.tls.mode });
      bound(info.port);
    },
  );
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
