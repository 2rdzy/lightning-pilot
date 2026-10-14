import { AppError } from '@lightning-pilot/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../../server.ts';
import { loadConfig } from '../../../config/config.ts';
import { createLogger } from '../../../logging/logger.ts';
import { openApiDocument } from '../../../http/app.ts';
import { listen } from '../../../http/listen.ts';
import { setupForTest, tempDir, testDriver, writeVaultKey } from '../../../testing.ts';
import { totp } from '../totp/totp.ts';
import { digest } from './source.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const PASSWORD = 'Correct-horse-9-battery';
async function harness(options: { trustedProxies?: string[]; transport?: 'direct' | 'tor' } = {}) {
  const t = tempDir();
  const key = writeVaultKey(t.dir);
  const clock = { now: new Date('2026-10-14T06:00:00Z') };
  const lines: string[] = [];
  const { config } = loadConfig({
    env: {},
    readFile: () =>
      JSON.stringify({
        server: { trustedProxies: options.trustedProxies ?? [] },
        tls: { mode: 'off' },
        paths: { dataDir: t.dir, vaultKey: key },
      }),
  });
  const logger = createLogger({ sink: (line) => lines.push(line) });
  const server = await buildServer({
    config,
    vaultKeyPath: key,
    dev: true,
    logger,
    driver: testDriver(),
    scryptCost: { log2N: 10, r: 8, p: 1 },
    now: () => clock.now,
    ...(options.transport ? { loginTransport: options.transport } : {}),
  });
  cleanups.push(async () => {
    await server.close();
    t.cleanup();
  });
  const token = (JSON.parse(lines.find((line) => line.includes('"setupToken"')) ?? '{}') as { setupToken: string })
    .setupToken;
  const enrolled = await setupForTest(server.setup, token, PASSWORD, clock.now);
  const request = (body: unknown, headers: Record<string, string> = {}, peer = '192.0.2.1') =>
    server.app.request(
      '/api/v1/auth/login',
      {
        method: 'POST',
        headers: { host: 'localhost', origin: 'https://localhost', 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress: peer } } },
    );
  const body = () => ({ password: PASSWORD, totpCode: totp(enrolled.secret, clock.now) });
  return { server, config, clock, logger, lines, enrolled, request, body };
}

describe('login HTTP admission boundary', () => {
  it('reports 429 and Retry-After without hashing twice and declares both admission errors in OpenAPI', async () => {
    const h = await harness();
    expect((await h.request({ password: 'incorrect' })).status).toBe(401);
    const res = await h.request(h.body(), { 'x-forwarded-for': '198.51.100.2', 'x-tor': '1' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await res.json()).toMatchObject({ error: { code: 'too_early', details: { retryAfter: 1 } } });
    expect(h.lines.filter((line) => line.includes('login scrypt timing'))).toHaveLength(1);
    expect(
      await h.server.db.selectFrom('login_throttles').select('kind').where('kind', '!=', 'global').execute(),
    ).toEqual([{ kind: 'ip' }]);
    const responses = openApiDocument(h.server.app).paths?.['/api/v1/auth/login']?.post?.responses;
    expect(responses).toHaveProperty('429');
    expect(responses).toHaveProperty('503');
  });

  it('returns 503 with Retry-After for a full lane and leaves cookies untouched', async () => {
    const h = await harness();
    vi.spyOn(h.server.auth, 'login').mockRejectedValueOnce(new AppError('busy', 'Login is busy.', { retryAfter: 1 }));
    const res = await h.request(h.body());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.json()).toMatchObject({ error: { code: 'busy' } });
  });

  it('issues a hashed known-device cookie at ordinary login and preserves it on logout', async () => {
    const h = await harness();
    const res = await h.request(h.body());
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    const device = cookies.find((cookie) => cookie.startsWith('__Host-lp_device=')) ?? '';
    expect(device).toMatch(/HttpOnly/);
    expect(device).toMatch(/Secure/);
    expect(device).toMatch(/SameSite=Strict/);
    expect(device).toMatch(/Path=\//);
    expect(device).toMatch(/Max-Age=31536000/);
    expect(device).not.toMatch(/Domain=/);
    const value = device.split(';')[0]?.split('=')[1] ?? '';
    expect(value).toHaveLength(43);
    expect(
      await h.server.db
        .selectFrom('known_devices')
        .select('id_hash')
        .where('id_hash', '=', digest(value))
        .executeTakeFirst(),
    ).toBeDefined();
    const session = cookies.find((cookie) => cookie.startsWith('__Host-lp_session='))?.split(';')[0] ?? '';
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    const logout = await h.server.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'https://localhost',
        cookie: `${session}; __Host-lp_device=${value}`,
        'x-csrf-token': csrfToken,
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('clear-site-data')).toBe('"cache", "storage"');
    expect(logout.headers.getSetCookie()).toHaveLength(1);
    expect(logout.headers.getSetCookie()[0]).toMatch(/^__Host-lp_session=.*Max-Age=0/);
    expect(
      await h.server.db
        .selectFrom('known_devices')
        .select('id_hash')
        .where('id_hash', '=', digest(value))
        .executeTakeFirst(),
    ).toBeDefined();
    h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    const again = await h.request(h.body(), { cookie: `__Host-lp_device=${value}` });
    expect(again.status).toBe(200);
    expect(again.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-lp_device='))).toContain(
      `=${value};`,
    );
    expect(h.lines.join('\n')).not.toContain(value);
  });

  it('uses trusted proxy sources and the separate trusted Tor listener property without guessing from headers', async () => {
    const direct = await harness({ trustedProxies: ['192.0.2.1'] });
    expect(
      (await direct.request({ password: 'incorrect' }, { 'x-forwarded-for': '198.51.100.1', 'x-tor': '1' })).status,
    ).toBe(401);
    expect((await direct.request({ password: 'incorrect' }, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(401);
    const onion = await harness({ transport: 'tor', trustedProxies: ['192.0.2.1'] });
    expect((await onion.request({ password: 'incorrect' }, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(401);
    expect((await onion.request(onion.body(), { 'x-forwarded-for': '198.51.100.2' })).status).toBe(429);
    expect(
      (await onion.request(onion.body(), { cookie: `__Host-lp_device=${onion.enrolled.reply.deviceCookie ?? ''}` }))
        .status,
    ).toBe(200);
    expect(
      await onion.server.db
        .selectFrom('login_throttles')
        .select('counter')
        .where('kind', '=', 'tor')
        .executeTakeFirst(),
    ).toEqual({ counter: 'tor' });
  });

  it('attributes real HTTP/1 requests to the socket, ignoring forged proxy and Tor headers', async () => {
    const h = await harness();
    h.config.server.port = 0;
    const listener = listen(h.server.app, h.config, h.logger);
    cleanups.push(() => listener.close());
    const port = await listener.port;
    const login = (forwarded: string) =>
      fetch(`http://localhost:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          origin: `http://localhost:${port}`,
          'content-type': 'application/json',
          'x-forwarded-for': forwarded,
          'x-tor': '1',
        },
        body: JSON.stringify({ password: 'incorrect' }),
      });
    const first = await login('198.51.100.1');
    expect(first.status).toBe(401);
    await first.arrayBuffer();
    const second = await login('198.51.100.2');
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('1');
    await second.arrayBuffer();
    const source = (
      await h.server.db.selectFrom('login_throttles').selectAll().where('kind', '=', 'ip').executeTakeFirstOrThrow()
    ).counter;
    const { directSource } = await import('./source.ts');
    expect(source).toBe(directSource({ peerAddress: '127.0.0.1' }, []).counter);
  });
});
