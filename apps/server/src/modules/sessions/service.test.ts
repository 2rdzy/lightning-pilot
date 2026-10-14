import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../logging/logger.ts';
import { tempDir, testDb } from '../../testing.ts';
import { SessionsService, sessionDigest } from './service.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(options: { idleMs?: number; absoluteMs?: number } = {}) {
  const t = tempDir();
  const { db } = await testDb(t.dir);
  const clock = { now: new Date('2026-10-14T08:00:00Z') };
  const logs: string[] = [];
  const sessions = new SessionsService({
    db,
    now: () => clock.now,
    logger: createLogger({ sink: (l) => logs.push(l) }),
    ...options,
  });
  cleanup.push(async () => {
    await sessions.close();
    await db.destroy();
    t.cleanup();
  });
  const first = await sessions.create(db, clock.now, false, '192.0.2.1');
  const idHash = sessionDigest(first.cookieValue);
  const row = await sessions.live(db, idHash);
  const step = (strength: 'password' | 'security' = 'password', matches = true, factor = true, id = idHash) =>
    sessions.stepUp(
      id,
      strength,
      'test',
      async () => ({ matches, snapshot: 'same' }),
      async () => factor,
    );
  return { db, clock, sessions, first, idHash, row, logs, step };
}

describe('server-side session lifecycle', () => {
  it('stores only a cookie digest, uses a stable handle and lists safe source metadata', async () => {
    const h = await fixture();
    expect(h.first.cookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.row.id_hash).not.toBe(h.first.cookieValue);
    expect(h.row.source).toBe('192.0.2.1');
    expect(await h.sessions.session('unknown')).toBeUndefined();
    const list = await h.sessions.list(h.row.handle);
    expect(list.items[0]).toMatchObject({ id: h.row.handle, current: true, endedAt: null, endReason: null });
    expect(JSON.stringify(list)).not.toContain(h.idHash);
    expect(JSON.stringify(list)).not.toContain(h.first.cookieValue);
  });
  it('background probes and streams do not extend idle time; expiry keeps an ended record', async () => {
    const h = await fixture();
    const close = vi.fn();
    await h.sessions.registerStream(h.first.cookieValue, close);
    h.clock.now = new Date('2026-10-14T08:59:00Z');
    expect((await h.sessions.session(h.first.cookieValue))?.expiresAt.toISOString()).toBe('2026-10-14T09:00:00.000Z');
    h.clock.now = new Date('2026-10-14T09:00:00Z');
    expect(await h.sessions.session(h.first.cookieValue, true)).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect((await h.db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow()).end_reason).toBe('expired');
    expect(await h.sessions.session(h.first.cookieValue)).toBeUndefined();
  });
  it('user-driven activity extends idle time and always records the last action', async () => {
    const h = await fixture();
    h.clock.now = new Date('2026-10-14T08:00:30Z');
    const active = await h.sessions.session(h.first.cookieValue, true);
    expect(active?.expiresAt.toISOString()).toBe('2026-10-14T09:00:30.000Z');
    expect((await h.sessions.live(h.db, h.idHash)).last_seen_at).toBe(h.clock.now.toISOString());
  });
  it('absolute expiry wins even when there is recent user activity', async () => {
    const h = await fixture({ idleMs: 60_000, absoluteMs: 120_000 });
    for (const ms of [30_000, 60_000, 90_000]) {
      h.clock.now = new Date(h.row.created_at);
      h.clock.now = new Date(h.clock.now.getTime() + ms);
      expect(await h.sessions.session(h.first.cookieValue, true)).toBeDefined();
    }
    h.clock.now = new Date(Date.parse(h.row.created_at) + 120_000);
    expect(await h.sessions.session(h.first.cookieValue, true)).toBeUndefined();
  });
  it('marks timed-out sessions while listing and exposes ended records without reviving them', async () => {
    const h = await fixture();
    h.clock.now = new Date('2026-10-14T09:00:00Z');
    const list = await h.sessions.list(h.row.handle);
    expect(list.items[0]).toMatchObject({ endReason: 'expired', endedAt: h.clock.now.toISOString() });
    await expect(h.sessions.live(h.db, h.idHash)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('revoke and everywhere logout immediately close all registered streams', async () => {
    const h = await fixture();
    const one = vi.fn();
    const two = vi.fn();
    const hook = vi.fn();
    const off = h.sessions.onEnd(hook);
    await h.sessions.registerStream(h.first.cookieValue, one);
    const other = await h.sessions.create(h.db, h.clock.now);
    await h.sessions.registerStream(other.cookieValue, two);
    await h.sessions.end(h.row.handle, 'revoked');
    expect(one).toHaveBeenCalledOnce();
    expect(two).not.toHaveBeenCalled();
    await h.sessions.endAll('everywhere');
    expect(two).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledTimes(2);
    off();
    await h.sessions.end('missing', 'revoked');
    expect(hook).toHaveBeenCalledTimes(2);
    expect(await h.sessions.session(other.cookieValue)).toBeUndefined();
  });
  it('can revoke other sessions only, and a missing handle is idempotent', async () => {
    const h = await fixture();
    const other = await h.sessions.create(h.db, h.clock.now);
    await h.sessions.endAll('security_change', h.row.handle);
    expect(await h.sessions.session(h.first.cookieValue)).toBeDefined();
    expect(await h.sessions.session(other.cookieValue)).toBeUndefined();
    await h.sessions.endAll('everywhere');
    await h.sessions.endAll('everywhere');
    await h.sessions.markEnded(h.db, [], 'logout');
  });
  it('bounds streams per session and safely unregisters before or after revocation', async () => {
    const h = await fixture();
    const callbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const off = await h.sessions.registerStream(h.first.cookieValue, callbacks[0] ?? vi.fn());
    await h.sessions.registerStream(h.first.cookieValue, callbacks[1] ?? vi.fn());
    await h.sessions.registerStream(h.first.cookieValue, callbacks[2] ?? vi.fn());
    await expect(h.sessions.registerStream(h.first.cookieValue, callbacks[3] ?? vi.fn())).rejects.toMatchObject({
      code: 'busy',
    });
    off();
    await h.sessions.end(h.row.handle, 'logout');
    off();
    expect(callbacks[0]).not.toHaveBeenCalled();
    expect(callbacks[1]).toHaveBeenCalledOnce();
    await expect(h.sessions.registerStream(h.first.cookieValue, vi.fn())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
  it('removes an empty stream registry and isolates throwing close hooks', async () => {
    const h = await fixture();
    const off = await h.sessions.registerStream(h.first.cookieValue, vi.fn());
    off();
    h.sessions.onEnd(() => {
      throw new Error('untrusted hook');
    });
    await h.sessions.registerStream(h.first.cookieValue, () => {
      throw new Error('stream close');
    });
    await h.sessions.end(h.row.handle, 'revoked');
    expect(h.logs.filter((line) => line.includes('session lifecycle hook failed'))).toHaveLength(2);
  });
  it('uses an expiry timer to close streams even when no request arrives', async () => {
    vi.useFakeTimers();
    const h = await fixture({ idleMs: 1000 });
    const close = vi.fn();
    await h.sessions.registerStream(h.first.cookieValue, close);
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(close).toHaveBeenCalledOnce();
  });
  it('reschedules a stream timer on user activity and preserves it across rotation', async () => {
    vi.useFakeTimers();
    const h = await fixture({ idleMs: 1000 });
    const close = vi.fn();
    await h.sessions.registerStream(h.first.cookieValue, close);
    h.clock.now = new Date(h.clock.now.getTime() + 500);
    await vi.advanceTimersByTimeAsync(500);
    await h.sessions.session(h.first.cookieValue, true);
    const rotated = await h.step();
    h.clock.now = new Date(h.clock.now.getTime() + 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(close).not.toHaveBeenCalled();
    expect(await h.sessions.session(rotated.cookieValue)).toBeDefined();
    h.clock.now = new Date(h.clock.now.getTime() + 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(close).toHaveBeenCalledOnce();
  });
  it('stops streams and fails closed on server shutdown', async () => {
    const h = await fixture();
    const close = vi.fn();
    await h.sessions.registerStream(h.first.cookieValue, close);
    await h.step();
    await h.sessions.close();
    expect(close).toHaveBeenCalledOnce();
    expect(await h.sessions.session(h.first.cookieValue)).toBeUndefined();
    await expect(h.sessions.live(h.db, h.idHash)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(h.step()).rejects.toMatchObject({ code: 'busy' });
  });
});

describe('step-up strength, rotation and throttling', () => {
  it('rotates cookie and CSRF, keeps handle/creation/absolute expiry, and expires the grant exactly at five minutes', async () => {
    const h = await fixture();
    const result = await h.step();
    expect(result.cookieValue).not.toBe(h.first.cookieValue);
    expect(result.csrfToken).not.toBe(h.first.csrfToken);
    expect(await h.sessions.session(h.first.cookieValue)).toBeUndefined();
    const row = await h.sessions.live(h.db, sessionDigest(result.cookieValue));
    expect(row.handle).toBe(h.row.handle);
    expect(row.created_at).toBe(h.row.created_at);
    expect(row.expires_at).toBe(h.row.expires_at);
    h.sessions.requireGrant(row, 'password');
    expect(() => h.sessions.requireGrant(row, 'security')).toThrow();
    h.clock.now = new Date(h.clock.now.getTime() + 5 * 60_000);
    expect(() => h.sessions.requireGrant(row, 'password')).toThrow();
  });
  it('security covers password-only work, while a later password step-up does not extend the security grant', async () => {
    const h = await fixture();
    const security = await h.step('security');
    let row = await h.sessions.live(h.db, sessionDigest(security.cookieValue));
    h.sessions.requireGrant(row, 'security');
    h.sessions.requireGrant(row, 'password');
    h.clock.now = new Date(h.clock.now.getTime() + 4 * 60_000);
    const password = await h.step('password', true, true, row.id_hash);
    row = await h.sessions.live(h.db, sessionDigest(password.cookieValue));
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    expect(() => h.sessions.requireGrant(row, 'security')).toThrow();
    h.sessions.requireGrant(row, 'password');
    h.sessions.clearGrants(row.handle);
    expect(() => h.sessions.requireGrant(row, 'password')).toThrow();
  });
  it('restart drops memory-only grants while keeping the session and durable penalty', async () => {
    const h = await fixture();
    const security = await h.step('security');
    const restarted = new SessionsService({
      db: h.db,
      now: () => h.clock.now,
      logger: createLogger({ sink: () => {} }),
    });
    const row = await restarted.live(h.db, sessionDigest(security.cookieValue));
    expect(() => restarted.requireGrant(row, 'security')).toThrow();
    await restarted.close();
  });
  it('delays 1, 2, 4, 8 seconds without hashing early, then revokes at the fifth admitted failure and alerts', async () => {
    const h = await fixture();
    const alert = vi.fn();
    const off = h.sessions.onStepUpRevoked(alert);
    const close = vi.fn();
    await h.sessions.registerStream(h.first.cookieValue, close);
    for (let n = 1; n <= 5; n++) {
      await expect(h.step('password', false)).rejects.toMatchObject({ code: 'login_failed' });
      const check = vi.fn(async () => ({ matches: false, snapshot: '' }));
      await expect(h.sessions.stepUp(h.idHash, 'password', 'r', check, async () => true)).rejects.toMatchObject({
        code: n < 5 ? 'too_early' : 'unauthenticated',
      });
      expect(check).not.toHaveBeenCalled();
      h.clock.now = new Date(h.clock.now.getTime() + 2 ** (n - 1) * 1000);
    }
    expect(close).toHaveBeenCalledOnce();
    expect(alert).toHaveBeenCalledOnce();
    off();
    expect((await h.db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow()).end_reason).toBe(
      'step_up_failures',
    );
  });
  it('persists a failed-factor penalty across restart and resets failures on successful step-up', async () => {
    const h = await fixture();
    await expect(h.step('security', true, false)).rejects.toMatchObject({ code: 'login_failed' });
    const restarted = new SessionsService({
      db: h.db,
      now: () => h.clock.now,
      logger: createLogger({ sink: () => {} }),
    });
    await expect(
      restarted.stepUp(
        h.idHash,
        'password',
        'r',
        async () => ({ matches: true, snapshot: '' }),
        async () => true,
      ),
    ).rejects.toMatchObject({ code: 'too_early' });
    await restarted.close();
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    const result = await h.step();
    const row = await h.sessions.live(h.db, sessionDigest(result.cookieValue));
    expect(row.step_up_failures).toBe(0);
    expect(row.step_up_retry_at).toBe(0);
  });
  it('claims before checking and only hashes one parallel attempt on the same session', async () => {
    const h = await fixture();
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const check = vi.fn(async () => {
      await wait;
      return { matches: true, snapshot: '' };
    });
    const first = h.sessions.stepUp(h.idHash, 'password', 'r', check, async () => true);
    await expect(h.step()).rejects.toMatchObject({ code: 'too_early' });
    release();
    await first;
    expect(check).toHaveBeenCalledOnce();
  });
  it('bounds hash capacity across sessions and rejects waiters on shutdown, draining the running check', async () => {
    const h = await fixture();
    const sessions = await Promise.all([1, 2, 3].map(() => h.sessions.create(h.db, h.clock.now)));
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const entered = vi.fn();
    const checks = [h.first, ...sessions].map(
      (session) => () =>
        h.sessions.stepUp(
          sessionDigest(session.cookieValue),
          'password',
          'r',
          async () => {
            entered();
            await wait;
            return { matches: true, snapshot: '' };
          },
          async () => true,
        ),
    );
    const pending = checks.slice(0, 3).map((check) => check().catch((error) => error as Error));
    await expect(checks[3]?.()).rejects.toMatchObject({ code: 'busy' });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    const closing = h.sessions.close();
    release();
    await closing;
    const outcomes = await Promise.all(pending);
    expect(outcomes.every((value) => value instanceof Error)).toBe(true);
  });
  it('rejects restricted recovery sessions and expired grants before executing sensitive work', async () => {
    const h = await fixture();
    const recovery = await h.sessions.create(h.db, h.clock.now, true);
    await expect(h.step('password', true, true, sessionDigest(recovery.cookieValue))).rejects.toMatchObject({
      code: 'permission_denied',
    });
    const fn = vi.fn(async () => 'wrong');
    await expect(h.sessions.authorized(h.idHash, 'security', fn)).rejects.toMatchObject({ code: 'step_up_required' });
    expect(fn).not.toHaveBeenCalled();
    const result = await h.step('security');
    expect(await h.sessions.authorized(sessionDigest(result.cookieValue), 'security', async () => 'ok')).toBe('ok');
    const row = await h.sessions.live(h.db, sessionDigest(recovery.cookieValue));
    expect(() => h.sessions.requireGrant(row, 'password')).toThrow();
  });
  it('rechecks revocation and expiration after an awaited hash; unexpected hash errors never count as guesses', async () => {
    const h = await fixture();
    await expect(
      h.sessions.stepUp(
        h.idHash,
        'password',
        'r',
        async () => {
          throw new Error('hash failure');
        },
        async () => true,
      ),
    ).rejects.toThrow('hash failure');
    expect((await h.sessions.live(h.db, h.idHash)).step_up_failures).toBe(0);
    await expect(
      h.sessions.stepUp(
        h.idHash,
        'password',
        'r',
        async () => {
          await h.sessions.end(h.row.handle, 'revoked');
          return { matches: true, snapshot: '' };
        },
        async () => true,
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await h.sessions.session(h.first.cookieValue)).toBeUndefined();
  });
});

describe('session policy', () => {
  it('loads defaults, protects changes with security step-up and persists them across restart', async () => {
    const h = await fixture();
    await h.sessions.loadPolicy();
    await expect(h.sessions.policy(h.idHash)).rejects.toMatchObject({ code: 'step_up_required' });
    const stepped = await h.step('security');
    const id = sessionDigest(stepped.cookieValue);
    expect(await h.sessions.policy(id)).toEqual({ idleSeconds: 3600, absoluteSeconds: 604800 });
    await h.sessions.changePolicy(id, { idleSeconds: 60, absoluteSeconds: 120 });
    const next = await h.sessions.create(h.db, h.clock.now);
    expect(next.expiresAt.getTime() - h.clock.now.getTime()).toBe(120_000);
    const restarted = new SessionsService({
      db: h.db,
      now: () => h.clock.now,
      logger: createLogger({ sink: () => {} }),
    });
    await restarted.loadPolicy();
    const next2 = await restarted.create(h.db, h.clock.now);
    expect(next2.expiresAt.getTime() - h.clock.now.getTime()).toBe(120_000);
    await restarted.close();
  });
  it('shortening idle lifetime closes expired streams immediately and reschedules live ones', async () => {
    const h = await fixture();
    const stepped = await h.step('security');
    const close = vi.fn();
    await h.sessions.registerStream(stepped.cookieValue, close);
    h.clock.now = new Date(h.clock.now.getTime() + 120_000);
    const active = await h.sessions.create(h.db, h.clock.now);
    const activeClose = vi.fn();
    await h.sessions.registerStream(active.cookieValue, activeClose);
    await h.sessions.changePolicy(sessionDigest(stepped.cookieValue), { idleSeconds: 60, absoluteSeconds: 120 });
    expect(close).toHaveBeenCalledOnce();
    expect(activeClose).not.toHaveBeenCalled();
  });
});

describe('stream registration and timer races', () => {
  it('cannot leave a stream open when revocation lands between validation and registration', async () => {
    const h = await fixture();
    const close = vi.fn();
    const original = h.sessions.live.bind(h.sessions);
    const spy = vi.spyOn(h.sessions, 'live').mockImplementationOnce(async (db, id) => {
      const row = await original(db, id);
      await h.sessions.end(row.handle, 'revoked');
      return row;
    });
    await expect(h.sessions.registerStream(h.first.cookieValue, close)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(close).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
  it('an already queued expiry callback rechecks renewed activity before ending a session', async () => {
    vi.useFakeTimers();
    const h = await fixture({ idleMs: 1000 });
    const close = vi.fn();
    await h.sessions.registerStream(h.first.cookieValue, close);
    // A writer can update activity before an already queued timer reads its row.
    h.clock.now = new Date(h.clock.now.getTime() + 900);
    await h.db
      .updateTable('sessions')
      .set({ last_seen_at: h.clock.now.toISOString() })
      .where('id_hash', '=', h.idHash)
      .execute();
    h.clock.now = new Date(h.clock.now.getTime() + 100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(close).not.toHaveBeenCalled();
    h.clock.now = new Date(h.clock.now.getTime() + 900);
    await vi.advanceTimersByTimeAsync(900);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('concurrent activity and expiry observations', () => {
  it('does not expire or report ended a row renewed between its initial read and expiry marking', async () => {
    const h = await fixture({ idleMs: 1000 });
    const end = h.sessions.end.bind(h.sessions);
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    const spy = vi.spyOn(h.sessions, 'end').mockImplementationOnce(async (handle, reason) => {
      await h.db
        .updateTable('sessions')
        .set({ last_seen_at: h.clock.now.toISOString() })
        .where('handle', '=', handle)
        .execute();
      return end(handle, reason);
    });
    expect(await h.sessions.session(h.first.cookieValue)).toBeDefined();
    spy.mockRestore();
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    vi.spyOn(h.sessions, 'end').mockImplementationOnce(async (handle, reason) => {
      await h.db
        .updateTable('sessions')
        .set({ last_seen_at: h.clock.now.toISOString() })
        .where('handle', '=', handle)
        .execute();
      return end(handle, reason);
    });
    expect((await h.sessions.list(h.row.handle)).items[0]?.endedAt).toBeNull();
  });
  it('invokes each stream close callback once if revoke lands during the final registration check', async () => {
    const h = await fixture();
    const close = vi.fn();
    const session = h.sessions.session.bind(h.sessions);
    vi.spyOn(h.sessions, 'session')
      .mockImplementationOnce(session)
      .mockImplementationOnce(async () => {
        await h.sessions.end(h.row.handle, 'revoked');
        return undefined;
      });
    await expect(h.sessions.registerStream(h.first.cookieValue, close)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('bounded password replacement work', () => {
  it('uses the shared session hash lane and rejects excess work before starting it', async () => {
    const h = await fixture();
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const work = vi.fn(async () => {
      await wait;
      return 'done';
    });
    const pending = [1, 2, 3].map(() => h.sessions.passwordWork(work));
    await expect(h.sessions.passwordWork(work)).rejects.toMatchObject({ code: 'busy' });
    expect(work).toHaveBeenCalledOnce();
    release();
    expect(await Promise.all(pending)).toEqual(['done', 'done', 'done']);
    await h.sessions.close();
    await expect(h.sessions.passwordWork(work)).rejects.toMatchObject({ code: 'busy' });
  });
  it('rejects queued replacements on shutdown and drains the running operation', async () => {
    const h = await fixture();
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const started = vi.fn();
    const first = h.sessions.passwordWork(async () => {
      started();
      await wait;
      return 'done';
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const queued = h.sessions.passwordWork(async () => 'never').catch((error) => error as Error);
    const shutting = h.sessions.close();
    release();
    await shutting;
    expect(await first).toBe('done');
    expect(await queued).toMatchObject({ code: 'busy' });
  });
});

describe('WP11 stable-handle stream validation', () => {
  it('keeps an existing stream valid after cookie rotation, without extending idle life', async () => {
    const h = await fixture();
    const close = vi.fn();
    await h.sessions.registerStream(h.first.cookieValue, close);
    await h.step();
    h.clock.now = new Date('2026-10-14T08:59:00Z');
    expect((await h.sessions.streamSession(h.row.handle))?.expiresAt.toISOString()).toBe('2026-10-14T09:00:00.000Z');
    h.clock.now = new Date('2026-10-14T09:00:00Z');
    expect(await h.sessions.streamSession(h.row.handle)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(await h.sessions.streamSession(h.row.handle)).toBeUndefined();
    expect(await h.sessions.streamSession('missing')).toBeUndefined();
  });
  it('refuses streams from restricted recovery sessions and fails closed on shutdown', async () => {
    const h = await fixture();
    const restricted = await h.sessions.create(h.db, h.clock.now, true);
    const row = await h.sessions.live(h.db, sessionDigest(restricted.cookieValue));
    expect(await h.sessions.streamSession(row.handle)).toBeUndefined();
    await expect(h.sessions.registerStream(restricted.cookieValue, vi.fn())).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await h.sessions.close();
    expect(await h.sessions.streamSession(h.row.handle)).toBeUndefined();
  });
  it('retries a heartbeat when activity was renewed before expiration committed', async () => {
    const h = await fixture({ idleMs: 1000 });
    const end = h.sessions.end.bind(h.sessions);
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    vi.spyOn(h.sessions, 'end').mockImplementationOnce(async (handle, reason) => {
      await h.db
        .updateTable('sessions')
        .set({ last_seen_at: h.clock.now.toISOString() })
        .where('handle', '=', handle)
        .execute();
      return end(handle, reason);
    });
    expect(await h.sessions.streamSession(h.row.handle)).toBeDefined();
  });
});

describe('absolute policy changes', () => {
  it('applies a shorter absolute cap to already live sessions without extending their original stored ceiling', async () => {
    const h = await fixture();
    const stepped = await h.step('security');
    const id = sessionDigest(stepped.cookieValue);
    await h.sessions.changePolicy(id, { idleSeconds: 60, absoluteSeconds: 120 });
    for (const delta of [30_000, 60_000, 90_000]) {
      h.clock.now = new Date(Date.parse(h.row.created_at) + delta);
      expect(await h.sessions.session(stepped.cookieValue, true)).toBeDefined();
    }
    h.clock.now = new Date(Date.parse(h.row.created_at) + 120_000);
    expect(await h.sessions.session(stepped.cookieValue, true)).toBeUndefined();
    expect(
      (await h.db.selectFrom('sessions').select('expires_at').where('id_hash', '=', id).executeTakeFirstOrThrow())
        .expires_at,
    ).toBe(h.row.expires_at);
  });
});
