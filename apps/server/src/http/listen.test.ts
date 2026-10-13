import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.ts';
import { createLogger } from '../logging/logger.ts';
import { buildServer, type Server } from '../server.ts';
import { tempDir, testDriver, writeVaultKey } from '../testing.ts';
import { listen, type Listener } from './listen.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('listen', () => {
  it('serves the app over plain HTTP on loopback when TLS is off, and closes', async () => {
    const { dir, cleanup } = tempDir();
    const vaultKey = writeVaultKey(dir);
    const { config } = loadConfig({
      readFile: () => JSON.stringify({ server: { port: 1 }, tls: { mode: 'off' }, paths: { dataDir: dir, vaultKey } }),
    });
    // Port 0: any free port (the schema needs 1–65535, so it is set after validation).
    config.server.port = 0;
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', sink: (l) => lines.push(l), stdout: (l) => lines.push(l) });
    const server: Server = await buildServer({
      config,
      vaultKeyPath: vaultKey,
      dev: false,
      logger,
      driver: testDriver(),
    });
    const listener: Listener = listen(server.app, config, logger);
    cleanups.push(async () => {
      await listener.close();
      await server.close();
      cleanup();
    });
    const port = await listener.port;
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://localhost:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(lines.some((l) => l.includes('"msg":"listening"') && l.includes('"tls":"off"'))).toBe(true);
    // The setup URL matches the scheme the server actually uses.
    expect(lines.some((l) => l.includes('"setupUrl":"http://localhost:0/setup"'))).toBe(true);
  });
});
