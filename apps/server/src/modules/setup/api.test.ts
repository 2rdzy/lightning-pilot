import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../logging/logger.ts';
import { buildServer, type Server } from '../../server.ts';
import { loadConfig } from '../../config/config.ts';
import { tempDir, testDriver, writeVaultKey } from '../../testing.ts';
import { totp } from '../auth/totp/totp.ts';
import { type SetupAction, type SetupProgress } from '@lightning-pilot/core';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const PASSWORD = 'Synthetic-Wizard-Pass-123!';
async function harness() {
  const t = tempDir();
  const key = writeVaultKey(t.dir);
  const logs: string[] = [];
  const clock = { now: new Date('2026-10-13T12:00:00Z') };
  const { config } = loadConfig({
    env: {},
    readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: t.dir, vaultKey: key } }),
  });
  const server = await buildServer({
    config,
    vaultKeyPath: key,
    dev: true,
    logger: createLogger({ sink: (l) => logs.push(l) }),
    driver: testDriver(),
    scryptCost: { log2N: 10, r: 8, p: 1 },
    now: () => clock.now,
  });
  cleanups.push(async () => {
    await server.close();
    t.cleanup();
  });
  const token = (JSON.parse(logs.find((l) => l.includes('"setupToken"')) ?? '{}') as { setupToken: string }).setupToken;
  const cookies = new Map<string, string>();
  let csrf: string | undefined;
  const request = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await server.app.request('/api/v1/setup', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'https://localhost',
        'content-type': 'application/json',
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join(';'),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    for (const value of res.headers.getSetCookie()) {
      const cookie = value.split(';')[0] ?? '';
      const at = cookie.indexOf('=');
      cookies.set(cookie.slice(0, at), cookie.slice(at + 1));
    }
    return res;
  };
  const act = async (body: SetupAction) => {
    const res = await request(body);
    expect(res.status, await res.clone().text()).toBe(200);
    const p = (await res.json()) as SetupProgress;
    csrf = p.csrfToken;
    return { res, p };
  };
  const start = () => act({ action: 'start', token });
  const finish = async () => {
    await start();
    const { p: enrol } = await act({ action: 'password', password: PASSWORD });
    const secret = enrol.secret ?? '';
    const { p: codes } = await act({ action: 'totp', code: totp(secret, new Date(clock.now.getTime() - 30_000)) });
    await act({ action: 'recovery', code: codes.recoveryCodes?.[0] ?? '' });
    await act({ action: 'backup', confirmed: true });
    await act({ action: 'node', node: null });
    await act({ action: 'alerts', alerts: { kind: 'none' } });
    return { secret, recoveryCode: codes.recoveryCodes?.[0] ?? '', ...(await act({ action: 'complete' })) };
  };
  return { server, logs, token, cookies, clock, request, act, start, finish };
}
describe('setup HTTP boundary', () => {
  it('requires the browser cookie and CSRF, refuses skipped stages and invalid inputs', async () => {
    const h = await harness();
    await h.start();
    for (const headers of [{ cookie: '' }, { 'x-csrf-token': '' }])
      expect((await h.request({ action: 'password', password: PASSWORD }, headers)).status).toBe(
        headers.cookie === '' ? 401 : 403,
      );
    expect((await h.request({ action: 'complete' })).status).toBe(400);
    expect((await h.request({ action: 'backup', confirmed: false })).status).toBe(400);
    expect((await h.request({ action: 'password', password: 'short' })).status).toBe(400);
    expect((await h.request({ action: 'password', password: 'A1!' + 'a'.repeat(126) })).status).toBe(400);
    expect((await h.request({ action: 'password', password: PASSWORD, extra: true })).status).toBe(400);
    expect(await h.server.db.selectFrom('owner').selectAll().execute()).toEqual([]);
  });
  it('commits once, sets owner/device cookies, and removes setup mutation after completion', async () => {
    const h = await harness();
    const { res } = await h.finish();
    const cookies = res.headers.getSetCookie();
    expect(
      cookies.some(
        (c) =>
          c.startsWith('__Host-lp_session=') && /HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Strict/.test(c),
      ),
    ).toBe(true);
    expect(cookies.some((c) => c.startsWith('__Host-lp_device=') && c.includes('Max-Age=31536000'))).toBe(true);
    expect(await h.server.db.selectFrom('recovery_codes').selectAll().execute()).toHaveLength(10);
    expect(await h.server.db.selectFrom('known_devices').selectAll().execute()).toHaveLength(1);
    expect((await h.request({ action: 'start', token: h.token })).status).toBe(404);
    expect(h.server.auth.setupMode).toBe(false);
  });
  it('keeps setup cookie usable while active and emits Retry-After on token throttling', async () => {
    const h = await harness();
    const bad = await h.request({ action: 'start', token: 'bad' });
    expect(bad.status).toBe(401);
    const delayed = await h.request({ action: 'start', token: h.token });
    expect(delayed.status).toBe(429);
    expect(delayed.headers.get('retry-after')).toBe('1');
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    await h.start();
    h.clock.now = new Date(h.clock.now.getTime() + 14 * 60_000);
    const { res } = await h.act({ action: 'password', password: PASSWORD });
    expect(res.headers.getSetCookie().some((c) => c.includes('__Host-lp_setup=') && c.includes('Expires='))).toBe(true);
  });
  it('enforces TOTP on login and atomically refuses code replay including parallel login', async () => {
    const h = await harness();
    const { secret } = await h.finish();
    const login = (code?: string) =>
      h.server.app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { host: 'localhost', origin: 'https://localhost', 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD, ...(code ? { totpCode: code } : {}) }),
      });
    expect((await login()).status).toBe(401);
    expect((await login('000000')).status).toBe(401);
    const code = totp(secret, h.clock.now);
    const attempts = await Promise.all([login(code), login(code)]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 401]);
    expect((await login(code)).status).toBe(401);
    const second = await h.server.db.selectFrom('auth_totp').selectAll().executeTakeFirstOrThrow();
    expect(second.last_counter).toBe(String(Math.floor(h.clock.now.getTime() / 30_000)));
  });
  it('does not put passwords, factors, recovery codes or cookies in logs', async () => {
    const h = await harness();
    await h.start();
    const { p: enrol } = await h.act({ action: 'password', password: PASSWORD });
    const secret = enrol.secret ?? '';
    const { p: codes } = await h.act({ action: 'totp', code: totp(secret, h.clock.now) });
    await h.act({ action: 'recovery', code: codes.recoveryCodes?.[0] ?? '' });
    await h.act({ action: 'backup', confirmed: true });
    await h.act({ action: 'node', node: null });
    await h.act({ action: 'alerts', alerts: { kind: 'none' } });
    await h.act({ action: 'complete' });
    const text = h.logs.join('\n');
    for (const canary of [PASSWORD, secret, ...(codes.recoveryCodes ?? []), ...h.cookies.values()])
      if (canary) expect(text).not.toContain(canary);
    const factor = await h.server.db.selectFrom('auth_totp').selectAll().executeTakeFirstOrThrow();
    expect(Buffer.from(factor.ciphertext).toString()).not.toContain(secret);
  });
});

async function authRequest(
  server: Server,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; csrf?: string | undefined } = {},
) {
  return server.app.request(path, {
    method: options.method ?? 'POST',
    headers: {
      host: 'localhost',
      origin: 'https://localhost',
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}
function sessionCookie(res: Response): string {
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith('__Host-lp_session='))
    ?.split(';')[0];
  if (!cookie) throw new Error('Missing login session cookie');
  return cookie;
}

describe('recovery login HTTP boundary', () => {
  it('consumes each code atomically and restricts recovery sessions until verified re-enrolment', async () => {
    const h = await harness();
    const initial = await h.finish();
    const ordinaryCookie = sessionCookie(initial.res);
    const logins = await Promise.all(
      [0, 1].map(() =>
        authRequest(h.server, '/api/v1/auth/login', {
          body: { password: PASSWORD, recoveryCode: initial.recoveryCode },
        }),
      ),
    );
    expect(logins.map((r) => r.status).sort()).toEqual([200, 401]);
    const successful = logins.find((r) => r.status === 200);
    if (!successful) throw new Error('No successful recovery login');
    const session = (await successful.json()) as { csrfToken: string; expiresAt: string; recoveryRequired?: boolean };
    expect(session.recoveryRequired).toBe(true);
    const cookie = sessionCookie(successful);
    expect(
      (
        await authRequest(h.server, '/api/v1/auth/login', {
          body: { password: PASSWORD, recoveryCode: initial.recoveryCode },
        })
      ).status,
    ).toBe(401);
    expect((await authRequest(h.server, '/api/v1/nodes', { method: 'GET', cookie })).status).toBe(403);
    expect((await authRequest(h.server, '/api/v1/auth/session', { method: 'GET', cookie })).status).toBe(200);
    expect((await authRequest(h.server, '/api/v1/auth/totp/enrol', { cookie })).status).toBe(403);
    const enrol = await authRequest(h.server, '/api/v1/auth/totp/enrol', { cookie, csrf: session.csrfToken });
    expect(enrol.status).toBe(200);
    const factor = (await enrol.json()) as { secret: string; uri: string };
    expect(factor.secret).not.toBe(initial.secret);
    expect(factor.uri).toContain(factor.secret);
    const correct = totp(factor.secret, h.clock.now);
    const wrong = correct === '000000' ? '111111' : '000000';
    expect(
      (
        await authRequest(h.server, '/api/v1/auth/totp/confirm', {
          cookie,
          csrf: session.csrfToken,
          body: { code: wrong },
        })
      ).status,
    ).toBe(400);
    expect((await authRequest(h.server, '/api/v1/nodes', { method: 'GET', cookie })).status).toBe(403);
    expect(
      (
        await authRequest(h.server, '/api/v1/auth/totp/confirm', {
          cookie,
          csrf: session.csrfToken,
          body: { code: correct },
        })
      ).status,
    ).toBe(204);
    expect((await authRequest(h.server, '/api/v1/nodes', { method: 'GET', cookie })).status).toBe(200);
    expect(
      (await authRequest(h.server, '/api/v1/auth/session', { method: 'GET', cookie: ordinaryCookie })).status,
    ).toBe(401);
    const restored = await authRequest(h.server, '/api/v1/auth/session', { method: 'GET', cookie });
    expect(
      ((await restored.json()) as { csrfToken: string; expiresAt: string; recoveryRequired?: boolean })
        .recoveryRequired,
    ).not.toBe(true);
    const stored = await h.server.db.selectFrom('auth_totp').selectAll().executeTakeFirstOrThrow();
    expect(Buffer.from(stored.ciphertext).toString()).not.toContain(factor.secret);
    expect(
      await h.server.db.selectFrom('recovery_codes').selectAll().where('used_at', 'is not', null).execute(),
    ).toHaveLength(1);
  });

  it('rejects malformed recovery codes, ambiguous factors and incorrect passwords without consuming codes', async () => {
    const h = await harness();
    const initial = await h.finish();
    for (const body of [
      { password: PASSWORD, recoveryCode: 'bad_code' },
      { password: 'Wrong-pass-123!', recoveryCode: initial.recoveryCode },
      { password: PASSWORD, totpCode: totp(initial.secret, h.clock.now), recoveryCode: initial.recoveryCode },
    ]) {
      const res = await authRequest(h.server, '/api/v1/auth/login', { body });
      expect([400, 401]).toContain(res.status);
    }
    expect(
      await h.server.db.selectFrom('recovery_codes').selectAll().where('used_at', 'is not', null).execute(),
    ).toEqual([]);
  });

  it('keeps the recovery secret stable across concurrent enrolment and confirmation, and clears it on close', async () => {
    const h = await harness();
    const initial = await h.finish();
    const login = await authRequest(h.server, '/api/v1/auth/login', {
      body: { password: PASSWORD, recoveryCode: initial.recoveryCode },
    });
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);
    const value = cookie.slice(cookie.indexOf('=') + 1);
    const idHash = createHash('sha256').update(value).digest('hex');
    const first = await h.server.auth.beginRecovery(idHash);
    expect(await h.server.auth.beginRecovery(idHash)).toEqual(first);
    const [repeated] = await Promise.all([
      h.server.auth.beginRecovery(idHash),
      h.server.auth.finishRecovery(idHash, totp(first.secret, h.clock.now), 'concurrent-test'),
    ]);
    expect(repeated).toEqual(first);
    expect((await h.server.auth.session(value))?.recoveryRequired).toBe(false);
    // A fresh synthetic recovery session proves close invalidates pending secrets without closing the database.
    const restricted = await h.server.auth.newSession(h.server.db, h.clock.now, true);
    const secondHash = createHash('sha256').update(restricted.cookieValue).digest('hex');
    const second = await h.server.auth.beginRecovery(secondHash);
    h.server.auth.close();
    await expect(
      h.server.auth.finishRecovery(secondHash, totp(second.secret, h.clock.now), 'closed-test'),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('requires a recovery login for re-enrolment and expires an unconfirmed new secret', async () => {
    const h = await harness();
    const initial = await h.finish();
    const ordinaryCookie = sessionCookie(initial.res);
    expect(
      (
        await authRequest(h.server, '/api/v1/auth/totp/enrol', {
          cookie: ordinaryCookie,
          csrf: initial.p.session?.csrfToken,
        })
      ).status,
    ).toBe(403);
    const login = await authRequest(h.server, '/api/v1/auth/login', {
      body: { password: PASSWORD, recoveryCode: initial.recoveryCode },
    });
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);
    const session = (await login.json()) as { csrfToken: string; expiresAt: string; recoveryRequired?: boolean };
    const enrol = await authRequest(h.server, '/api/v1/auth/totp/enrol', { cookie, csrf: session.csrfToken });
    const factor = (await enrol.json()) as { secret: string };
    h.clock.now = new Date(h.clock.now.getTime() + 15 * 60_000);
    expect(
      (
        await authRequest(h.server, '/api/v1/auth/totp/confirm', {
          cookie,
          csrf: session.csrfToken,
          body: { code: totp(factor.secret, h.clock.now) },
        })
      ).status,
    ).toBe(400);
    expect((await authRequest(h.server, '/api/v1/nodes', { method: 'GET', cookie })).status).toBe(403);
    expect((await authRequest(h.server, '/api/v1/auth/logout', { cookie, csrf: session.csrfToken })).status).toBe(204);
  });
});
