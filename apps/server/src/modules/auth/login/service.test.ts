import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService, verifyPassword } from '../service.ts';
import { totp } from '../totp/totp.ts';
import { SetupService } from '../../setup/index.ts';
import { NodesService } from '../../nodes/index.ts';
import { Vault } from '../../vault/index.ts';
import { createLogger } from '../../../logging/logger.ts';
import { tempDir, testDb, setupForTest } from '../../../testing.ts';
import { DEVICE_LIFETIME_MS, digest, directSource } from './source.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const PASSWORD = 'Correct-horse-9-battery';
const COST = { log2N: 10, r: 8, p: 1 };
async function harness(verifier = verifyPassword) {
  const t = tempDir();
  const { db, raw } = await testDb(t.dir);
  const clock = { now: new Date('2026-10-14T06:00:00Z') };
  const logs: string[] = [];
  const tokens: string[] = [];
  const logger = createLogger({
    sink: (line) => logs.push(line),
    stdout: (line) => tokens.push((JSON.parse(line) as { setupToken: string }).setupToken),
  });
  const vault = await Vault.start(db, randomBytes(32));
  const options = {
    db,
    raw,
    vault,
    logger,
    setupUrl: 'https://localhost/setup',
    scryptCost: COST,
    now: () => clock.now,
    passwordVerifier: verifier,
  };
  const auth = await AuthService.create(options);
  const nodes = new NodesService({ db, vault, logger, dev: true, maxNodes: 5 });
  const setup = new SetupService({ db, vault, auth, nodes, logger, scryptCost: COST, now: () => clock.now });
  cleanups.push(async () => {
    setup.close();
    await auth.close();
    vault.close();
    await db.destroy();
    t.cleanup();
  });
  await auth.issueSetupToken();
  const initial = await setupForTest(setup, tokens[0] ?? '', PASSWORD, clock.now);
  const login = (deviceCookie?: string, origin = {}) =>
    auth.login(PASSWORD, 'login', totp(initial.secret, clock.now), undefined, origin, deviceCookie);
  return { ...options, auth, initial, login, logs, clock };
}

describe('factor login and device registration', () => {
  it('recognises the setup device, renews its cookie/unused lifetime, resets its own counter atomically, and stores only a hash', async () => {
    const h = await harness();
    const cookie = h.initial.reply.deviceCookie ?? '';
    const hash = digest(cookie);
    await expect(h.auth.login('incorrect', 'bad', undefined, undefined, {}, cookie)).rejects.toMatchObject({
      code: 'login_failed',
    });
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    const session = await h.login(cookie, { transport: 'tor' });
    expect(session.deviceCookie).toBe(cookie);
    expect(session.recoveryRequired).toBe(false);
    expect(await h.db.selectFrom('known_devices').selectAll().execute()).toHaveLength(1);
    const device = await h.db
      .selectFrom('known_devices')
      .selectAll()
      .where('id_hash', '=', hash)
      .executeTakeFirstOrThrow();
    expect(device.last_seen_at).toBe(h.clock.now.toISOString());
    expect(device.expires_at).toBe(new Date(h.clock.now.getTime() + DEVICE_LIFETIME_MS).toISOString());
    expect(device.source).toBe('setup');
    expect(await h.db.selectFrom('login_throttles').selectAll().execute()).toEqual([]);
    expect(JSON.stringify(device)).not.toContain(cookie);
    expect(h.logs.some((line) => line.includes('login scrypt timing') && line.includes('"log2N":10'))).toBe(true);
    expect(h.logs.some((line) => line.includes('login succeeded') && line.includes('"sourceKind":"device"'))).toBe(
      true,
    );
    for (const secret of [
      cookie,
      PASSWORD,
      h.initial.secret,
      totp(h.initial.secret, h.clock.now),
      session.cookieValue,
    ]) {
      expect(h.logs.join('\n')).not.toContain(secret);
    }
  });

  it.each(['absent', 'unknown', 'malformed', 'revoked', 'expired'] as const)(
    'registers a new device after an ordinary login with an %s cookie',
    async (kind) => {
      const h = await harness();
      let cookie: string | undefined = h.initial.reply.deviceCookie;
      if (kind === 'absent') cookie = undefined;
      if (kind === 'unknown') cookie = randomBytes(32).toString('base64url');
      if (kind === 'malformed') cookie = 'not-a-cookie';
      if (kind === 'revoked') await h.db.deleteFrom('known_devices').execute();
      if (kind === 'expired') h.clock.now = new Date(h.clock.now.getTime() + DEVICE_LIFETIME_MS);
      const session = await h.login(cookie, { peerAddress: '2001:db8:1:2::1' });
      expect(session.deviceCookie).toHaveLength(43);
      expect(session.deviceCookie).not.toBe(cookie);
      const device = await h.db
        .selectFrom('known_devices')
        .selectAll()
        .where('id_hash', '=', digest(session.deviceCookie))
        .executeTakeFirstOrThrow();
      expect(device.source).toBe('2001:0db8:0001:0002::/64');
      expect(device.created_at).toBe(h.clock.now.toISOString());
    },
  );

  it('does not refresh a device revoked while its password is checked', async () => {
    let enter: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness(async (password, hash) => {
      enter();
      await ready;
      return verifyPassword(password, hash);
    });
    const cookie = h.initial.reply.deviceCookie ?? '';
    const pending = h.login(cookie);
    await entered;
    await h.db.deleteFrom('known_devices').execute();
    release();
    const session = await pending;
    expect(session.deviceCookie).not.toBe(cookie);
    expect(
      await h.db.selectFrom('known_devices').selectAll().where('id_hash', '=', digest(cookie)).executeTakeFirst(),
    ).toBeUndefined();
  });

  it('counts a wrong/missing/replayed factor and recovery code as a failed login without consuming a factor', async () => {
    const h = await harness();
    const snapshot = await h.db.selectFrom('auth_totp').selectAll().executeTakeFirstOrThrow();
    for (const [i, factor] of [undefined, 'invalid'].entries()) {
      const peerAddress = `192.0.2.${i}`;
      await expect(h.auth.login(PASSWORD, 'factor', factor, undefined, { peerAddress })).rejects.toMatchObject({
        code: 'login_failed',
      });
      expect(
        await h.db
          .selectFrom('login_throttles')
          .select('failures')
          .where('counter', '=', directSource({ peerAddress }, []).counter)
          .executeTakeFirst(),
      ).toEqual({ failures: 1 });
    }
    expect(await h.db.selectFrom('auth_totp').selectAll().executeTakeFirstOrThrow()).toEqual(snapshot);
    await expect(
      h.auth.login(PASSWORD, 'code', undefined, 'invalid', { peerAddress: '192.0.2.3' }),
    ).rejects.toMatchObject({ code: 'login_failed' });
    const code = totp(h.initial.secret, h.clock.now);
    await h.auth.login(PASSWORD, 'accepted', code, undefined, { peerAddress: '192.0.2.4' });
    await expect(h.auth.login(PASSWORD, 'replay', code, undefined, { peerAddress: '192.0.2.5' })).rejects.toMatchObject(
      { code: 'login_failed' },
    );
    const row = await h.db.selectFrom('recovery_codes').selectAll().executeTakeFirstOrThrow();
    expect(row.used_at).toBeNull();
  });

  it('registers a device on a single-use recovery login while retaining the restricted session', async () => {
    const h = await harness();
    // The saved proof code remains unused after setup.
    const recovery = await h.db.selectFrom('recovery_codes').selectAll().executeTakeFirstOrThrow();
    const { hashRecoveryCode } = await import('../totp/recovery.ts');
    const { generateRecoveryCodes } = await import('../totp/recovery.ts');
    const code = generateRecoveryCodes()[0] ?? '';
    await h.db
      .updateTable('recovery_codes')
      .set({ code_hash: hashRecoveryCode(code) })
      .where('code_hash', '=', recovery.code_hash)
      .execute();
    const session = await h.auth.login(PASSWORD, 'recovery', undefined, code, { transport: 'tor' });
    expect(session.recoveryRequired).toBe(true);
    expect(session.deviceCookie).toHaveLength(43);
    expect(
      await h.db
        .selectFrom('known_devices')
        .select('source')
        .where('id_hash', '=', digest(session.deviceCookie))
        .executeTakeFirst(),
    ).toEqual({ source: 'tor' });
    await expect(h.auth.login(PASSWORD, 'reuse', undefined, code, { peerAddress: '192.0.2.8' })).rejects.toMatchObject({
      code: 'login_failed',
    });
  });

  it('rolls back factor, session and counter/device changes together if device storage fails, allowing the same code to retry', async () => {
    const h = await harness();
    const before = await h.db.selectFrom('auth_totp').selectAll().executeTakeFirstOrThrow();
    h.raw.exec(
      "CREATE TRIGGER reject_device BEFORE INSERT ON known_devices BEGIN SELECT RAISE(ABORT, 'device storage failed'); END",
    );
    await expect(h.login()).rejects.toThrow('device storage failed');
    expect(await h.db.selectFrom('auth_totp').selectAll().executeTakeFirstOrThrow()).toEqual(before);
    expect(await h.db.selectFrom('sessions').selectAll().execute()).toHaveLength(1);
    expect(await h.db.selectFrom('login_throttles').selectAll().execute()).toEqual([]);
    h.raw.exec('DROP TRIGGER reject_device');
    expect((await h.login()).deviceCookie).toHaveLength(43);
  });

  it('drains an active password check on close without accessing the closed vault or creating a session', async () => {
    let enter: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verifier = vi.fn(async () => {
      enter();
      await ready;
      return true;
    });
    const h = await harness(verifier);
    const pending = h.login();
    const outcome = expect(pending).rejects.toMatchObject({ code: 'busy' });
    await entered;
    const closing = h.auth.close();
    release();
    await outcome;
    await closing;
    expect(await h.db.selectFrom('sessions').selectAll().execute()).toHaveLength(1);
    expect(await h.db.selectFrom('login_throttles').selectAll().execute()).toEqual([]);
    await expect(h.login()).rejects.toMatchObject({ code: 'busy' });
  });
});
