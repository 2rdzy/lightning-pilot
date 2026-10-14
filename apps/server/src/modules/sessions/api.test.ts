import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '@lightning-pilot/adapter-kit';
import { loadConfig } from '../../config/config.ts';
import { createLogger } from '../../logging/logger.ts';
import { buildServer } from '../../server.ts';
import { setupForTest, tempDir, testDriver, writeVaultKey } from '../../testing.ts';
import { totp } from '../auth/totp/totp.ts';
import { hashRecoveryCode } from '../auth/totp/recovery.ts';
import { sessionDigest } from './service.ts';

const PASSWORD = 'Synthetic-Session-Password-123!';
const NEW_PASSWORD = 'Replacement-Session-Password-456!';
const CA = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const ID = '0b6c4b8e-0000-4000-8000-000000000000';
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
});
async function harness() {
  const t = tempDir();
  const key = writeVaultKey(t.dir);
  const logs: string[] = [];
  const clock = { now: new Date('2026-10-14T08:00:00Z') };
  const { config } = loadConfig({
    readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: t.dir, vaultKey: key } }),
  });
  const server = await buildServer({
    config,
    vaultKeyPath: key,
    dev: true,
    driver: testDriver(),
    logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }),
    now: () => clock.now,
    scryptCost: { log2N: 10, r: 8, p: 1 },
    adapterFactory: () => new FakeAdapter({ chain: 'blake2b', network: 'regtest' }),
  });
  close.push(async () => {
    await server.close();
    t.cleanup();
  });
  const token = (JSON.parse(logs.find((line) => line.includes('"setupToken"')) ?? '{}') as { setupToken: string })
    .setupToken;
  const enrolled = await setupForTest(server.setup, token, PASSWORD, clock.now);
  const auth = {
    cookieValue: enrolled.reply.sessionCookie ?? '',
    csrf: enrolled.reply.progress.session?.csrfToken ?? '',
  };
  const request = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    credentials = auth,
  ) =>
    Promise.resolve(
      server.app.request(path, {
        method,
        headers: {
          host: 'localhost',
          origin: 'https://localhost',
          cookie: `__Host-lp_session=${credentials.cookieValue}`,
          'x-csrf-token': credentials.csrf,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const step = async (strength: 'password' | 'security' = 'security', code = totp(enrolled.secret, clock.now)) => {
    const res = await request(
      'POST',
      '/api/v1/auth/step-up',
      { password: PASSWORD, strength, ...(strength === 'security' ? { totpCode: code } : {}) },
      { 'x-user-activity': '1' },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const data = (await res.json()) as { csrfToken: string; expiresAt: string; stepUpExpiresAt: string };
    auth.cookieValue = (res.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? '';
    auth.csrf = data.csrfToken;
    return { res, data };
  };
  const idHash = () => sessionDigest(auth.cookieValue);
  return { server, clock, logs, enrolled, auth, request, step, idHash };
}
const error = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const nodeBody = {
  name: 'node',
  chain: 'blake2b',
  network: 'regtest',
  implementation: 'cln',
  url: 'https://localhost:9999',
  caCertificate: CA,
  viewRune: 'view',
  spendRune: 'spend',
};
const securityRoutes = [
  ['GET', '/api/v1/auth/devices', undefined],
  ['POST', `/api/v1/auth/devices/${ID}/revoke`, undefined],
  ['POST', '/api/v1/auth/password', { password: NEW_PASSWORD }],
  ['POST', '/api/v1/auth/totp/change/enrol', undefined],
  ['POST', '/api/v1/auth/totp/change/confirm', { code: '000000' }],
  ['GET', '/api/v1/auth/recovery-codes', undefined],
  ['POST', '/api/v1/auth/recovery-codes/regenerate', undefined],
  ['GET', '/api/v1/auth/session-policy', undefined],
  ['POST', '/api/v1/auth/session-policy', { idleSeconds: 60, absoluteSeconds: 120 }],
  ['POST', '/api/v1/nodes', nodeBody],
] as const;

describe('session HTTP and security-settings boundaries', () => {
  it('refuses every security operation without security step-up, including after password-only step-up', async () => {
    const h = await harness();
    for (const [method, path, body] of securityRoutes) {
      const res = await h.request(method, path, body);
      expect(res.status, path).toBe(403);
      expect(await error(res)).toBe('step_up_required');
    }
    await h.step('password');
    for (const [method, path, body] of securityRoutes) {
      expect(await error(await h.request(method, path, body)), path).toBe('step_up_required');
    }
  });
  it('counts a wrong TOTP code at security step-up on the account-wide factor counter; a full success clears it', async () => {
    const h = await harness();
    const factor = () =>
      h.server.db.selectFrom('login_throttles').selectAll().where('counter', '=', 'factor').executeTakeFirst();
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    const wrong = await h.request('POST', '/api/v1/auth/step-up', {
      password: PASSWORD,
      strength: 'security',
      totpCode: '000000' === totp(h.enrolled.secret, h.clock.now) ? '111111' : '000000',
    });
    expect(await error(wrong)).toBe('login_failed');
    expect((await factor())?.failures).toBe(1);
    // A wrong password is not a factor guess.
    h.clock.now = new Date(h.clock.now.getTime() + 2_000);
    const badPassword = await h.request('POST', '/api/v1/auth/step-up', {
      password: 'wrong-password',
      strength: 'password',
    });
    expect(await error(badPassword)).toBe('login_failed');
    expect((await factor())?.failures).toBe(1);
    // Step-up does not wait on the account counter (the session has its own delay), so the owner can still prove both factors.
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    await h.step('security');
    expect(await factor()).toBeUndefined();
    expect(h.logs.some((l) => l.includes('"step-up failed"') && l.includes('"factor":"totp"'))).toBe(true);
  });
  it('rotates the secure host cookie and CSRF, preserves handle and absolute expiry, and rejects the old cookie', async () => {
    const h = await harness();
    const before = { ...h.auth };
    const row = await h.server.auth.sessions.live(h.server.db, h.idHash());
    const { res, data } = await h.step();
    const cookie = res.headers.get('set-cookie') ?? '';
    for (const attribute of ['__Host-lp_session=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'])
      expect(cookie).toContain(attribute);
    expect(cookie).not.toContain('Domain=');
    expect(h.auth.csrf).not.toBe(before.csrf);
    expect(data.expiresAt).toBe(row.expires_at);
    expect(data.stepUpExpiresAt).toBe('2026-10-14T08:05:00.000Z');
    expect((await h.server.auth.sessions.live(h.server.db, h.idHash())).handle).toBe(row.handle);
    expect((await h.request('GET', '/api/v1/auth/session', undefined, {}, before)).status).toBe(401);
    expect((await h.request('POST', '/api/v1/auth/logout', undefined, { 'x-csrf-token': before.csrf })).status).toBe(
      403,
    );
  });
  it('does not accept recovery codes as a security factor and validates all new route inputs', async () => {
    const h = await harness();
    expect(
      (
        await h.request('POST', '/api/v1/auth/step-up', {
          password: PASSWORD,
          strength: 'security',
          recoveryCode: 'ABCD',
        })
      ).status,
    ).toBe(400);
    expect((await h.request('POST', '/api/v1/auth/step-up', { password: PASSWORD, strength: 'security' })).status).toBe(
      400,
    );
    expect(
      (
        await h.request('POST', '/api/v1/auth/step-up', {
          password: PASSWORD,
          strength: 'password',
          totpCode: '123456',
        })
      ).status,
    ).toBe(400);
    await h.step();
    expect((await h.request('POST', '/api/v1/auth/password', { password: 'weak' })).status).toBe(400);
    expect(
      (await h.request('POST', '/api/v1/auth/session-policy', { idleSeconds: 100, absoluteSeconds: 60 })).status,
    ).toBe(400);
    expect((await h.request('POST', '/api/v1/auth/devices/invalid/revoke')).status).toBe(400);
    expect((await h.request('POST', '/api/v1/auth/sessions/invalid/revoke')).status).toBe(400);
  });
  it('applies Host/Origin/CSRF checks before activity touch and rejects cross-site JSON, form and text', async () => {
    const h = await harness();
    const seen = async () => (await h.server.auth.sessions.live(h.server.db, h.idHash())).last_seen_at;
    h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    expect(
      (await h.request('POST', '/api/v1/auth/logout', undefined, { 'x-user-activity': '1', 'x-csrf-token': 'wrong' }))
        .status,
    ).toBe(403);
    expect(await seen()).toBe('2026-10-14T08:00:00.000Z');
    for (const type of ['application/json', 'application/x-www-form-urlencoded', 'text/plain']) {
      expect(
        (
          await h.request(
            'POST',
            '/api/v1/auth/step-up',
            { password: PASSWORD, strength: 'password' },
            { 'content-type': type, origin: 'https://evil.test', 'x-user-activity': '1' },
          )
        ).status,
      ).toBe(403);
    }
    expect((await h.request('GET', '/api/v1/auth/sessions', undefined, { host: 'evil.test' })).status).toBe(421);
    expect(await seen()).toBe('2026-10-14T08:00:00.000Z');
    await h.request('GET', '/api/v1/auth/session', undefined, { 'x-user-activity': 'true' });
    expect(await seen()).toBe('2026-10-14T08:00:00.000Z');
    await h.request('GET', '/api/v1/auth/session', undefined, { 'x-user-activity': '1' });
    expect(await seen()).toBe(h.clock.now.toISOString());
  });
  it('lists source metadata, revokes another session and itself, and closes streams', async () => {
    const h = await harness();
    const other = await h.server.auth.newSession(h.server.db, h.clock.now, false, 'tor');
    const stream = vi.fn();
    await h.server.auth.sessions.registerStream(other.cookieValue, stream);
    const list = (await (await h.request('GET', '/api/v1/auth/sessions')).json()) as {
      items: { id: string; current: boolean; source: string }[];
    };
    expect(list.items).toHaveLength(2);
    expect(list.items.some((item) => item.source === 'tor')).toBe(true);
    const target = list.items.find((item) => !item.current)?.id;
    expect((await h.request('POST', `/api/v1/auth/sessions/${String(target)}/revoke`)).status).toBe(204);
    expect(stream).toHaveBeenCalledOnce();
    const ended = (await (await h.request('GET', '/api/v1/auth/sessions')).json()) as {
      items: { endReason: string | null }[];
    };
    expect(ended.items.some((item) => item.endReason === 'revoked')).toBe(true);
    const self = list.items.find((item) => item.current)?.id;
    const res = await h.request('POST', `/api/v1/auth/sessions/${String(self)}/revoke`);
    expect(res.status).toBe(204);
    expect(res.headers.get('clear-site-data')).toBe('"cache", "storage"');
    expect((await h.request('GET', '/api/v1/auth/session')).status).toBe(401);
  });
  it('logout everywhere closes all streams and clears cache/storage without deleting known-device identities', async () => {
    const h = await harness();
    const other = await h.server.auth.newSession(h.server.db, h.clock.now);
    const one = vi.fn();
    const two = vi.fn();
    await h.server.auth.sessions.registerStream(h.auth.cookieValue, one);
    await h.server.auth.sessions.registerStream(other.cookieValue, two);
    const res = await h.request('POST', '/api/v1/auth/logout-everywhere');
    expect(res.status).toBe(204);
    expect(res.headers.get('clear-site-data')).toBe('"cache", "storage"');
    expect(one).toHaveBeenCalledOnce();
    expect(two).toHaveBeenCalledOnce();
    expect(await h.server.db.selectFrom('known_devices').selectAll().execute()).toHaveLength(1);
  });
  it('uses generic failure errors, sends Retry-After, then ends the session and emits the fifth-failure hook', async () => {
    const h = await harness();
    const alert = vi.fn();
    h.server.auth.sessions.onStepUpRevoked(alert);
    const code = await h.server.db.selectFrom('login_throttles').selectAll().execute();
    for (let n = 1; n <= 5; n++) {
      const res = await h.request('POST', '/api/v1/auth/step-up', { password: 'wrong', strength: 'password' });
      expect(await error(res)).toBe('login_failed');
      const early = await h.request('POST', '/api/v1/auth/step-up', { password: PASSWORD, strength: 'password' });
      expect(early.status).toBe(n < 5 ? 429 : 401);
      if (n < 5) expect(early.headers.get('retry-after')).toBe(String(2 ** (n - 1)));
      h.clock.now = new Date(h.clock.now.getTime() + 2 ** (n - 1) * 1000);
    }
    expect(alert).toHaveBeenCalledOnce();
    expect(await h.server.db.selectFrom('login_throttles').selectAll().execute()).toEqual(code);
  });
  it('reuses the atomic TOTP counter across login and step-up in both directions', async () => {
    const h = await harness();
    const code = totp(h.enrolled.secret, h.clock.now);
    await h.step();
    await expect(
      h.server.auth.login(PASSWORD, 'r', code, undefined, {}, h.enrolled.reply.deviceCookie),
    ).rejects.toMatchObject({ code: 'login_failed' });
    h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    const login = await h.server.auth.login(
      PASSWORD,
      'r',
      totp(h.enrolled.secret, h.clock.now),
      undefined,
      {},
      h.enrolled.reply.deviceCookie,
    );
    await expect(
      h.server.auth.stepUp(
        sessionDigest(login.cookieValue),
        PASSWORD,
        'security',
        totp(h.enrolled.secret, h.clock.now),
        'r',
      ),
    ).rejects.toMatchObject({ code: 'login_failed' });
    expect((await h.server.auth.sessions.live(h.server.db, sessionDigest(login.cookieValue))).step_up_failures).toBe(1);
  });
  it('only one of parallel login and step-up can consume a fresh TOTP code', async () => {
    const h = await harness();
    const code = totp(h.enrolled.secret, h.clock.now);
    const outcomes = await Promise.allSettled([
      h.server.auth.login(PASSWORD, 'r', code, undefined, {}, h.enrolled.reply.deviceCookie),
      h.server.auth.stepUp(h.idHash(), PASSWORD, 'security', code, 'r'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });
  it('lists random public device handles and deletion revokes the protected identity without ending sessions', async () => {
    const h = await harness();
    await h.step();
    const list = (await (await h.request('GET', '/api/v1/auth/devices')).json()) as { items: { id: string }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.id).not.toBe(sessionDigest(h.enrolled.reply.deviceCookie ?? ''));
    expect((await h.request('POST', `/api/v1/auth/devices/${String(list.items[0]?.id)}/revoke`)).status).toBe(204);
    expect(await h.server.db.selectFrom('known_devices').selectAll().execute()).toHaveLength(0);
    expect((await h.request('GET', '/api/v1/auth/session')).status).toBe(200);
    h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    const result = await h.server.auth.login(
      PASSWORD,
      'r',
      totp(h.enrolled.secret, h.clock.now),
      undefined,
      {},
      h.enrolled.reply.deviceCookie,
    );
    expect(result.deviceCookie).not.toBe(h.enrolled.reply.deviceCookie);
  });
  it('regenerates ten recovery codes once, invalidates old hashes, and counts remaining unused codes', async () => {
    const h = await harness();
    await h.step();
    expect(await (await h.request('GET', '/api/v1/auth/recovery-codes')).json()).toEqual({ remaining: 10 });
    const original = await h.server.db.selectFrom('recovery_codes').selectAll().execute();
    const reply = await h.request('POST', '/api/v1/auth/recovery-codes/regenerate');
    expect(reply.status).toBe(200);
    const { codes } = (await reply.json()) as { codes: string[] };
    expect(codes).toHaveLength(10);
    const hashes = (await h.server.db.selectFrom('recovery_codes').selectAll().execute()).map((row) => row.code_hash);
    expect(hashes).toEqual(codes.map(hashRecoveryCode));
    expect(hashes.some((hash) => original.some((row) => row.code_hash === hash))).toBe(false);
    const restricted = await h.server.auth.login(PASSWORD, 'r', undefined, codes[0], {}, h.enrolled.reply.deviceCookie);
    expect(restricted.recoveryRequired).toBe(true);
    expect(await (await h.request('GET', '/api/v1/auth/recovery-codes')).json()).toEqual({ remaining: 9 });
    for (const [method, path, body] of [
      ['GET', '/api/v1/auth/sessions', undefined],
      ['POST', '/api/v1/auth/step-up', { password: PASSWORD, strength: 'password' }],
    ] as const) {
      expect(
        (await h.request(method, path, body, {}, { cookieValue: restricted.cookieValue, csrf: restricted.csrfToken }))
          .status,
      ).toBe(403);
    }
    for (const code of codes) expect(h.logs.join('\n')).not.toContain(code);
  });
  it('changes password with the stored cost, keeps current session, clears grants and closes other sessions', async () => {
    const h = await harness();
    const other = await h.server.auth.newSession(h.server.db, h.clock.now);
    const ended = vi.fn();
    await h.server.auth.sessions.registerStream(other.cookieValue, ended);
    await h.step();
    const res = await h.request('POST', '/api/v1/auth/password', { password: NEW_PASSWORD });
    expect(res.status, await res.text()).toBe(204);
    expect(ended).toHaveBeenCalledOnce();
    expect(await h.server.auth.session(other.cookieValue)).toBeUndefined();
    expect((await h.request('GET', '/api/v1/auth/session')).status).toBe(200);
    expect(await error(await h.request('GET', '/api/v1/auth/devices'))).toBe('step_up_required');
    const hash = (await h.server.db.selectFrom('owner').selectAll().executeTakeFirstOrThrow()).password_hash;
    expect(hash).toMatch(/^scrypt\$10\$8\$1\$/);
    const failed = await h.request('POST', '/api/v1/auth/step-up', { password: PASSWORD, strength: 'password' });
    expect(await error(failed)).toBe('login_failed');
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    const success = await h.request('POST', '/api/v1/auth/step-up', { password: NEW_PASSWORD, strength: 'password' });
    expect(success.status).toBe(200);
    expect(h.logs.join('\n')).not.toContain(NEW_PASSWORD);
  });
  it('does not accept a password step-up if the stored password changed while hashing', async () => {
    const h = await harness();
    const owner = await h.server.db.selectFrom('owner').selectAll().executeTakeFirstOrThrow();
    await expect(
      h.server.auth.sessions.stepUp(
        h.idHash(),
        'password',
        'r',
        async () => {
          await h.server.db.updateTable('owner').set({ password_hash: 'changed' }).where('id', '=', 1).execute();
          return { matches: true, snapshot: owner.password_hash };
        },
        async (db, snapshot) =>
          (await db.selectFrom('owner').select('password_hash').executeTakeFirstOrThrow()).password_hash === snapshot,
      ),
    ).rejects.toMatchObject({ code: 'login_failed' });
  });
  it('requires proof of a new authenticator before replacing it and invalidates grants/other sessions', async () => {
    const h = await harness();
    await h.step();
    const other = await h.server.auth.newSession(h.server.db, h.clock.now);
    const ended = vi.fn();
    await h.server.auth.sessions.registerStream(other.cookieValue, ended);
    const first = await h.request('POST', '/api/v1/auth/totp/change/enrol');
    expect(first.status).toBe(200);
    const pending = (await first.json()) as { secret: string; uri: string; expiresAt: string };
    expect(await (await h.request('POST', '/api/v1/auth/totp/change/enrol')).json()).toEqual(pending);
    const wrong = totp(pending.secret, new Date(h.clock.now.getTime() - 300_000));
    expect((await h.request('POST', '/api/v1/auth/totp/change/confirm', { code: wrong })).status).toBe(400);
    expect(
      (await h.request('POST', '/api/v1/auth/totp/change/confirm', { code: totp(pending.secret, h.clock.now) })).status,
    ).toBe(204);
    expect(ended).toHaveBeenCalledOnce();
    expect(await error(await h.request('GET', '/api/v1/auth/recovery-codes'))).toBe('step_up_required');
    await expect(
      h.server.auth.login(
        PASSWORD,
        'r',
        totp(pending.secret, h.clock.now),
        undefined,
        {},
        h.enrolled.reply.deviceCookie,
      ),
    ).rejects.toMatchObject({ code: 'login_failed' });
    h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    const login = await h.server.auth.login(
      PASSWORD,
      'r',
      totp(pending.secret, h.clock.now),
      undefined,
      {},
      h.enrolled.reply.deviceCookie,
    );
    expect(login.recoveryRequired).toBe(false);
    expect(h.logs.join('\n')).not.toContain(pending.secret);
  });
  it('expired pending enrollment can be restarted, but expired step-up cannot confirm', async () => {
    const h = await harness();
    await h.step();
    const pending = await h.server.auth.beginTotpChange(h.idHash());
    h.clock.now = new Date(h.clock.now.getTime() + 15 * 60_000);
    await expect(
      h.server.auth.finishTotpChange(h.idHash(), totp(pending.secret, h.clock.now), 'r'),
    ).rejects.toMatchObject({ code: 'step_up_required' });
    await h.step();
    await expect(
      h.server.auth.finishTotpChange(h.idHash(), totp(pending.secret, h.clock.now), 'r'),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const fresh = await h.server.auth.beginTotpChange(h.idHash());
    expect(fresh.secret).not.toBe(pending.secret);
  });
  it('updates session-policy APIs and preserves existing absolute deadlines', async () => {
    const h = await harness();
    await h.step();
    expect(await (await h.request('GET', '/api/v1/auth/session-policy')).json()).toEqual({
      idleSeconds: 3600,
      absoluteSeconds: 604800,
    });
    const original = (await h.server.auth.sessions.live(h.server.db, h.idHash())).expires_at;
    expect(
      (await h.request('POST', '/api/v1/auth/session-policy', { idleSeconds: 60, absoluteSeconds: 120 })).status,
    ).toBe(204);
    expect((await h.server.auth.sessions.live(h.server.db, h.idHash())).expires_at).toBe(original);
    expect(await (await h.request('GET', '/api/v1/auth/session-policy')).json()).toEqual({
      idleSeconds: 60,
      absoluteSeconds: 120,
    });
  });
  it('rejects sensitive settings exactly five minutes after step-up, without leaking credentials in logs', async () => {
    const h = await harness();
    await h.step();
    h.clock.now = new Date(h.clock.now.getTime() + 5 * 60_000);
    for (const [method, path, body] of securityRoutes)
      expect(await error(await h.request(method, path, body))).toBe('step_up_required');
    const logs = h.logs.filter((line) => !line.includes('"setupToken"')).join('\n');
    for (const secret of [PASSWORD, h.enrolled.secret, h.auth.cookieValue, h.auth.csrf])
      expect(logs).not.toContain(secret);
    expect(logs).not.toContain('view');
    expect(logs).not.toContain('spend');
  });
  it('uses an enrolled factor and live session during step-up; missing factor fails closed', async () => {
    const h = await harness();
    await h.server.db.deleteFrom('auth_totp').execute();
    expect(
      await error(
        await h.request('POST', '/api/v1/auth/step-up', {
          password: PASSWORD,
          strength: 'security',
          totpCode: '123456',
        }),
      ),
    ).toBe('login_failed');
    expect(
      (
        await h.request(
          'POST',
          '/api/v1/auth/step-up',
          { password: PASSWORD, strength: 'password' },
          {},
          { cookieValue: randomBytes(32).toString('base64url'), csrf: 'none' },
        )
      ).status,
    ).toBe(401);
  });
});

describe('security-setting concurrency and pending-state bounds', () => {
  it('does not replace a password that changed during the new-password hash', async () => {
    const h = await harness();
    await h.step();
    const original = h.server.auth.sessions.authorized.bind(h.server.auth.sessions);
    const spy = vi.spyOn(h.server.auth.sessions, 'authorized').mockImplementationOnce(async (id, strength, fn) => {
      const snapshot = await original(id, strength, fn);
      await h.server.db
        .updateTable('owner')
        .set({ password_hash: 'concurrent-replacement' })
        .where('id', '=', 1)
        .execute();
      return snapshot;
    });
    await expect(h.server.auth.changePassword(h.idHash(), NEW_PASSWORD, 'r')).rejects.toMatchObject({
      code: 'step_up_required',
    });
    expect((await h.server.db.selectFrom('owner').selectAll().executeTakeFirstOrThrow()).password_hash).toBe(
      'concurrent-replacement',
    );
    spy.mockRestore();
  });
  it('bounds pending TOTP enrollment across sessions and releases slots on revoke and expiry', async () => {
    const h = await harness();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const session = await h.server.auth.newSession(h.server.db, h.clock.now);
      const stepped = await h.server.auth.stepUp(
        sessionDigest(session.cookieValue),
        PASSWORD,
        'security',
        totp(h.enrolled.secret, h.clock.now),
        'r',
      );
      const id = sessionDigest(stepped.cookieValue);
      ids.push(id);
      if (i < 10) await h.server.auth.beginTotpChange(id);
      else await expect(h.server.auth.beginTotpChange(id)).rejects.toMatchObject({ code: 'busy' });
      h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    }
    const last = ids[10] ?? '';
    const first = await h.server.auth.sessions.live(h.server.db, ids[0] ?? '');
    await h.server.auth.sessions.end(first.handle, 'revoked');
    await h.server.auth.beginTotpChange(last);
    h.clock.now = new Date(h.clock.now.getTime() + 15 * 60_000);
    const row = await h.server.auth.sessions.live(h.server.db, last);
    const stepped = await h.server.auth.stepUp(last, PASSWORD, 'security', totp(h.enrolled.secret, h.clock.now), 'r');
    const pending = await h.server.auth.beginTotpChange(sessionDigest(stepped.cookieValue));
    expect(pending.secret).toBeTruthy();
    expect(row.handle).toBe(
      (await h.server.auth.sessions.live(h.server.db, sessionDigest(stepped.cookieValue))).handle,
    );
  });
  it('refuses a pending enrollment when the password snapshot changed and requires a fresh authorized begin', async () => {
    const h = await harness();
    await h.step();
    const pending = await h.server.auth.beginTotpChange(h.idHash());
    await h.server.db.updateTable('owner').set({ password_hash: 'changed' }).where('id', '=', 1).execute();
    await expect(
      h.server.auth.finishTotpChange(h.idHash(), totp(pending.secret, h.clock.now), 'r'),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('allows at most one concurrent password change to use a grant', async () => {
    const h = await harness();
    await h.step();
    const result = await Promise.allSettled([
      h.server.auth.changePassword(h.idHash(), NEW_PASSWORD, 'r'),
      h.server.auth.changePassword(h.idHash(), 'Another-Strong-Password-789!', 'r'),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('credential admission after RPC verification', () => {
  it('does not store node credentials when step-up expires during verification', async () => {
    const h = await harness();
    await h.step();
    const prepare = h.server.nodes.prepare.bind(h.server.nodes);
    vi.spyOn(h.server.nodes, 'prepare').mockImplementationOnce(async (input, requestId) => {
      const prepared = await prepare(input, requestId);
      h.clock.now = new Date(h.clock.now.getTime() + 5 * 60_000);
      return prepared;
    });
    const response = await h.request('POST', '/api/v1/nodes', nodeBody);
    expect(response.status).toBe(403);
    expect(await error(response)).toBe('step_up_required');
    expect(await h.server.db.selectFrom('nodes').selectAll().execute()).toEqual([]);
    expect(await h.server.db.selectFrom('credentials').selectAll().execute()).toEqual([]);
  });
  it('does not store node credentials after the session is revoked during verification', async () => {
    const h = await harness();
    await h.step();
    const prepare = h.server.nodes.prepare.bind(h.server.nodes);
    const row = await h.server.auth.sessions.live(h.server.db, h.idHash());
    vi.spyOn(h.server.nodes, 'prepare').mockImplementationOnce(async (input, requestId) => {
      const prepared = await prepare(input, requestId);
      await h.server.auth.sessions.end(row.handle, 'revoked');
      return prepared;
    });
    const response = await h.request('POST', '/api/v1/nodes', nodeBody);
    expect(response.status).toBe(401);
    expect(await error(response)).toBe('unauthenticated');
    expect(await h.server.db.selectFrom('nodes').selectAll().execute()).toEqual([]);
    expect(await h.server.db.selectFrom('credentials').selectAll().execute()).toEqual([]);
  });
});

describe('public device-source privacy', () => {
  it('never includes a cookie hash through new or legacy session/device provenance', async () => {
    const h = await harness();
    const device = h.enrolled.reply.deviceCookie ?? '';
    const digest = sessionDigest(device);
    const login = await h.server.auth.login(PASSWORD, 'r', totp(h.enrolled.secret, h.clock.now), undefined, {}, device);
    const stored = await h.server.auth.sessions.live(h.server.db, sessionDigest(login.cookieValue));
    expect(stored.source).toBe('device');
    // A legacy registration racing device revocation could have persisted WP07's raw counter descriptor.
    await h.server.db
      .updateTable('known_devices')
      .set({ source: `device:${digest}` })
      .execute();
    await h.server.db
      .updateTable('sessions')
      .set({ source: `device:${digest}` })
      .where('id_hash', '=', h.idHash())
      .execute();
    const sessions = await (await h.request('GET', '/api/v1/auth/sessions')).text();
    expect(sessions).not.toContain(digest);
    expect(sessions).not.toContain(device);
    h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    await h.step();
    const devices = await (await h.request('GET', '/api/v1/auth/devices')).text();
    expect(devices).not.toContain(digest);
    expect(devices).not.toContain(device);
    expect(JSON.parse(devices) as { items: { source: string }[] }).toMatchObject({ items: [{ source: 'device' }] });
  });
});
