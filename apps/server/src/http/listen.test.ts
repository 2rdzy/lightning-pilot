import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:http2';
import { join } from 'node:path';
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

  // Browsers speak HTTP/2 over TLS, where the host is in :authority and there is no Host header.
  it('serves HTTP/2 over TLS: the Host allowlist and Origin check read :authority', async () => {
    const { dir, cleanup } = tempDir();
    const vaultKey = writeVaultKey(dir);
    // A throwaway certificate made with openssl, as the install script will do; no key is committed.
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    const { config } = loadConfig({
      readFile: () =>
        JSON.stringify({
          server: { port: 1 },
          tls: { mode: 'files', certFile: cert, keyFile: key },
          paths: { dataDir: dir, vaultKey },
        }),
    });
    config.server.port = 0;
    const logger = createLogger({ level: 'error', sink: () => undefined });
    const server = await buildServer({ config, vaultKeyPath: vaultKey, dev: false, logger, driver: testDriver() });
    const listener = listen(server.app, config, logger);
    const port = await listener.port;
    const client = connect(`https://localhost:${port}`, { ca: readFileSync(cert) });
    cleanups.push(async () => {
      client.close();
      await listener.close();
      await server.close();
      cleanup();
    });
    const call = (headers: Record<string, string>, body?: string) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const stream = client.request(headers);
        let status = 0;
        let text = '';
        stream.on('response', (h) => (status = Number(h[':status'])));
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => (text += chunk));
        stream.on('end', () => resolve({ status, text }));
        stream.on('error', reject);
        stream.end(body);
      });

    const health = await call({ ':method': 'GET', ':path': '/healthz' });
    expect(health).toEqual({ status: 200, text: '{"status":"ok"}' });
    // An unsafe request with this origin passes Host and Origin and reaches the route (setup is not done yet).
    const login = await call(
      {
        ':method': 'POST',
        ':path': '/api/v1/auth/login',
        origin: `https://localhost:${port}`,
        'content-type': 'application/json',
      },
      '{"password":"x"}',
    );
    expect(JSON.parse(login.text)).toMatchObject({ error: { code: 'setup_required' } });
    const foreign = await call(
      {
        ':method': 'POST',
        ':path': '/api/v1/auth/login',
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      '{"password":"x"}',
    );
    expect(JSON.parse(foreign.text)).toMatchObject({ error: { code: 'bad_origin' } });
    const unknown = await call({ ':method': 'GET', ':path': '/healthz', ':authority': `evil.example:${port}` });
    expect(unknown.status).toBe(421);
  });
});
