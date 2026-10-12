import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../logging/logger.ts';
import { tempDir, testDb } from '../../testing.ts';
import { Vault } from '../vault/index.ts';
import { AuthService, hashPassword, verifyPassword } from './service.ts';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const COST = { log2N: 10, r: 8, p: 1 };
const PASSWORD = 'Correct-horse-9-battery';

async function service(clock: { now: Date }) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const { db } = await testDb(t.dir);
  const vault = await Vault.start(db, randomBytes(32));
  const tokens: string[] = [];
  const logger = createLogger({
    sink: () => undefined,
    stdout: (l) => tokens.push((JSON.parse(l) as { setupToken: string }).setupToken),
  });
  const auth = await AuthService.create({
    db,
    vault,
    logger,
    setupUrl: 'https://localhost/setup',
    scryptCost: COST,
    now: () => clock.now,
  });
  return { auth, db, vault, tokens };
}

describe('passwords', () => {
  it('verifies the right password only, and refuses an unknown hash format', async () => {
    const hash = await hashPassword(PASSWORD, COST);
    expect(hash).toMatch(/^scrypt\$10\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('Wrong-horse-9-battery', hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'bcrypt$whatever')).toBe(false);
  });
});

describe('setup token', () => {
  it('is 28 base32 characters in groups of four, and is not issued once an owner exists', async () => {
    const clock = { now: new Date('2026-10-12T10:00:00Z') };
    const { auth, tokens } = await service(clock);
    await auth.issueSetupToken();
    expect(tokens[0]).toMatch(/^([A-Z2-7]{4}-){6}[A-Z2-7]{4}$/);
    await auth.completeSetup(tokens[0] ?? '', PASSWORD, 'r-1');
    await auth.issueSetupToken();
    expect(tokens).toHaveLength(1);
  });

  it('expires after 24 hours', async () => {
    const clock = { now: new Date('2026-10-12T10:00:00Z') };
    const { auth, tokens } = await service(clock);
    await auth.issueSetupToken();
    clock.now = new Date('2026-10-13T10:00:01Z');
    await expect(auth.completeSetup(tokens[0] ?? '', PASSWORD, 'r-1')).rejects.toMatchObject({
      code: 'setup_token_invalid',
    });
  });

  it('refuses setup when an owner appeared meanwhile, leaving the vault uninitialised', async () => {
    const clock = { now: new Date('2026-10-12T10:00:00Z') };
    const { auth, db, vault, tokens } = await service(clock);
    await auth.issueSetupToken();
    await db.insertInto('owner').values({ id: 1, password_hash: 'x', created_at: clock.now.toISOString() }).execute();
    await expect(auth.completeSetup(tokens[0] ?? '', PASSWORD, 'r-1')).rejects.toMatchObject({ code: 'not_found' });
    expect(vault.initialised).toBe(false);
  });
});

describe('sessions', () => {
  async function loggedIn() {
    const clock = { now: new Date('2026-10-12T10:00:00Z') };
    const s = await service(clock);
    await s.auth.issueSetupToken();
    await s.auth.completeSetup(s.tokens[0] ?? '', PASSWORD, 'r-1');
    const session = await s.auth.login(PASSWORD, 'r-2');
    return { ...s, clock, cookie: session.cookieValue };
  }
  const at = (iso: string) => new Date(iso);

  it('ends after one idle hour and deletes the session', async () => {
    const { auth, db, clock, cookie } = await loggedIn();
    clock.now = at('2026-10-12T10:59:00Z');
    expect(await auth.session(cookie)).toBeDefined();
    clock.now = at('2026-10-12T11:58:00Z');
    expect(await auth.session(cookie)).toBeDefined();
    clock.now = at('2026-10-12T13:00:00Z');
    expect(await auth.session(cookie)).toBeUndefined();
    expect(await db.selectFrom('sessions').selectAll().execute()).toEqual([]);
  });

  it('ends after seven days even when used every half hour', async () => {
    const { auth, clock, cookie } = await loggedIn();
    let t = at('2026-10-12T10:00:00Z').getTime();
    const end = at('2026-10-19T10:00:00Z').getTime();
    while (t + 30 * 60_000 < end) {
      t += 30 * 60_000;
      clock.now = new Date(t);
      expect(await auth.session(cookie)).toBeDefined();
    }
    clock.now = new Date(end);
    expect(await auth.session(cookie)).toBeUndefined();
  });

  it('writes last-seen at most once a minute', async () => {
    const { auth, db, clock, cookie } = await loggedIn();
    const seen = async () =>
      (await db.selectFrom('sessions').select('last_seen_at').executeTakeFirstOrThrow()).last_seen_at;
    clock.now = at('2026-10-12T10:00:30Z');
    await auth.session(cookie);
    expect(await seen()).toBe('2026-10-12T10:00:00.000Z');
    clock.now = at('2026-10-12T10:01:30Z');
    await auth.session(cookie);
    expect(await seen()).toBe('2026-10-12T10:01:30.000Z');
  });

  it('refuses login before setup and with a wrong password', async () => {
    const clock = { now: new Date('2026-10-12T10:00:00Z') };
    const { auth } = await service(clock);
    await expect(auth.login(PASSWORD, 'r')).rejects.toMatchObject({ code: 'setup_required' });
    const s = await loggedIn();
    await expect(s.auth.login('Wrong-horse-9-battery', 'r')).rejects.toMatchObject({ code: 'login_failed' });
  });
});

describe('password cost', () => {
  it('uses scrypt N = 2^17, r = 8, p = 1 by default, and treats a hash scrypt refuses as no match', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$17\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, 'scrypt$40$8$1$AAAA$AAAA')).toBe(false);
    const t = tempDir();
    cleanups.push(t.cleanup);
    const { db } = await testDb(t.dir);
    const tokens: string[] = [];
    const logger = createLogger({
      sink: () => undefined,
      stdout: (l) => tokens.push((JSON.parse(l) as { setupToken: string }).setupToken),
    });
    const auth = await AuthService.create({ db, vault: await Vault.start(db, randomBytes(32)), logger, setupUrl: 'x' });
    await auth.issueSetupToken();
    await auth.completeSetup(tokens[0] ?? '', PASSWORD, 'r');
    const owner = await db.selectFrom('owner').select('password_hash').executeTakeFirstOrThrow();
    expect(owner.password_hash).toMatch(/^scrypt\$17\$/);
  });
});
