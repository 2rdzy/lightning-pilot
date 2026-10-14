import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@lightning-pilot/core';
import { createLogger } from '../../../logging/logger.ts';
import { writeTx } from '../../../storage/db.ts';
import { tempDir, testDb } from '../../../testing.ts';
import { DEVICE_LIFETIME_MS, digest, directSource, type LoginOrigin } from './source.ts';
import { COUNTER_DECAY_MS, LoginThrottle, UNKNOWN_COUNTER_LIMIT } from './throttle.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const badLogin = () => Promise.reject(new AppError('login_failed', 'Login failed.'));
const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

async function harness() {
  const t = tempDir();
  const { db, raw } = await testDb(t.dir);
  const clock = { ms: Date.parse('2026-10-14T06:00:00Z') };
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line) });
  const make = () =>
    new LoginThrottle({ db, raw, logger, now: () => new Date(clock.ms), trustedProxies: ['127.0.0.1'] });
  const throttle = make();
  cleanups.push(async () => {
    await throttle.close();
    await db.destroy();
    t.cleanup();
  });
  const row = (counter: string) =>
    db.selectFrom('login_throttles').selectAll().where('counter', '=', counter).executeTakeFirst();
  const known = async (age = 0, expiry = DEVICE_LIFETIME_MS) => {
    const cookie = randomBytes(32).toString('base64url');
    await db
      .insertInto('known_devices')
      .values({
        id_hash: digest(cookie),
        created_at: new Date(clock.ms - age).toISOString(),
        last_seen_at: new Date(clock.ms - age).toISOString(),
        expires_at: new Date(clock.ms + expiry).toISOString(),
      })
      .execute();
    return cookie;
  };
  const fail = (origin: LoginOrigin = {}, cookie?: string) => throttle.run(origin, cookie, 'failure', badLogin);
  const pass = (origin: LoginOrigin = {}, cookie?: string) =>
    throttle.run(origin, cookie, 'success', async ({ source }) => {
      await writeTx(db, (trx) => throttle.succeeded(trx, source));
      return source;
    });
  return { db, raw, clock, lines, make, throttle, row, known, fail, pass };
}

describe('login throttling cases', () => {
  it.each(Array.from({ length: 13 }, (_, index) => index + 1))(
    'failure %i gives the doubling delay through 900 seconds without early hashing',
    async (n) => {
      const h = await harness();
      const cookie = await h.known();
      for (let i = 1; i <= n; i++) {
        await expect(h.fail({}, cookie)).rejects.toMatchObject({ code: 'login_failed' });
        if (i < n) h.clock.ms += Math.min(2 ** (i - 1), 900) * 1000;
      }
      const delay = Math.min(2 ** (n - 1), 900);
      const verifier = vi.fn(badLogin);
      await expect(h.throttle.run({}, cookie, 'early', verifier)).rejects.toMatchObject({
        code: 'too_early',
        details: { retryAfter: delay },
      });
      expect(verifier).not.toHaveBeenCalled();
      h.clock.ms += delay * 1000 - 1;
      await expect(h.throttle.run({}, cookie, 'early', verifier)).rejects.toMatchObject({ details: { retryAfter: 1 } });
      h.clock.ms++;
      await expect(h.throttle.run({}, cookie, 'allowed', verifier)).rejects.toMatchObject({ code: 'login_failed' });
      expect(verifier).toHaveBeenCalledTimes(1);
    },
  );

  it('claims before hashing, records the failure before release and rejects parallel guesses', async () => {
    const h = await harness();
    const entered = deferred();
    const finish = deferred();
    const verifier = vi.fn(async () => {
      entered.resolve();
      await finish.promise;
      return badLogin();
    });
    const first = h.throttle.run({}, undefined, 'first', verifier);
    const outcome = expect(first).rejects.toMatchObject({ code: 'login_failed' });
    await entered.promise;
    const other = await Promise.allSettled(
      Array.from({ length: 7 }, () => h.throttle.run({}, undefined, 'parallel', verifier)),
    );
    expect(
      other.every((result) => result.status === 'rejected' && (result.reason as AppError).code === 'too_early'),
    ).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(1);
    finish.resolve();
    await outcome;
    await expect(h.fail()).rejects.toMatchObject({ code: 'too_early' });
    expect((await h.row(directSource({}, []).counter))?.failures).toBe(1);
  });

  it('runs one hash per lane, holds two waiters, bounds a rotating-source flood, and isolates known devices', async () => {
    const h = await harness();
    const cookie = await h.known();
    const entered = deferred();
    const release = deferred();
    let running = 0;
    let peak = 0;
    const verifier = vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      entered.resolve();
      await release.promise;
      running--;
    });
    const first = h.throttle.run({ peerAddress: '198.51.100.1' }, undefined, 'first', verifier);
    await entered.promise;
    const results = Array.from({ length: 1000 }, (_, i) =>
      h.throttle.run({ peerAddress: `10.0.${Math.floor(i / 256)}.${i % 256}` }, 'A'.repeat(43), 'flood', verifier),
    );
    const outcomes = results.map((promise) =>
      promise.then(
        () => 'ok',
        (error: AppError) => error.code,
      ),
    );
    await tick();
    expect(verifier).toHaveBeenCalledTimes(1);
    expect((await h.pass({ transport: 'tor' }, cookie)).kind).toBe('device');
    release.resolve();
    await first;
    const counts = await Promise.all(outcomes);
    expect(counts.filter((code) => code === 'ok')).toHaveLength(2);
    expect(counts.filter((code) => code === 'busy')).toHaveLength(998);
    expect(peak).toBe(1);
    expect(h.lines).toHaveLength(4); // Only the four completed checks, not the 998 rejected requests.
  });

  it('keeps known-device counters independent of IP, Tor and other devices; falls back for invalid, revoked or expired cookies', async () => {
    const h = await harness();
    const a = await h.known();
    const b = await h.known();
    await expect(h.fail({ peerAddress: '192.0.2.1' })).rejects.toMatchObject({ code: 'login_failed' });
    await expect(h.fail({ transport: 'tor' })).rejects.toMatchObject({ code: 'login_failed' });
    await expect(h.fail({}, a)).rejects.toMatchObject({ code: 'login_failed' });
    expect((await h.pass({ peerAddress: '192.0.2.1' }, b)).counter).toBe(`device:${digest(b)}`);
    await expect(h.fail({ transport: 'tor' }, a)).rejects.toMatchObject({ code: 'too_early' });
    const expired = await h.known(0, 0);
    const unused = await h.known(DEVICE_LIFETIME_MS);
    for (const cookie of [expired, unused, 'not-a-cookie', randomBytes(32).toString('base64url')]) {
      await expect(h.fail({ transport: 'tor' }, cookie)).rejects.toMatchObject({ code: 'too_early' });
    }
    await h.db.deleteFrom('known_devices').where('id_hash', '=', digest(b)).execute();
    await expect(h.fail({ peerAddress: '192.0.2.1' }, b)).rejects.toMatchObject({ code: 'too_early' });
  });

  it('resets only the successful source and preserves the global failure window', async () => {
    const h = await harness();
    const origin = { peerAddress: '192.0.2.1' };
    await expect(h.fail(origin)).rejects.toMatchObject({ code: 'login_failed' });
    h.clock.ms += 1000;
    await h.pass(origin);
    expect(await h.row(directSource(origin, []).counter)).toBeUndefined();
    expect((await h.row('global'))?.failures).toBe(1);
    await expect(h.fail(origin)).rejects.toMatchObject({ code: 'login_failed' });
    expect((await h.row(directSource(origin, []).counter))?.failures).toBe(1);
  });

  it('persists the global soft cap across restart, protects devices, and expires the fixed window at its boundary', async () => {
    const h = await harness();
    const cookie = await h.known();
    for (let i = 0; i < 30; i++)
      await expect(h.fail({ peerAddress: `192.0.2.${i}` })).rejects.toMatchObject({ code: 'login_failed' });
    const verifier = vi.fn(badLogin);
    await expect(h.throttle.run({ peerAddress: '198.51.100.1' }, undefined, 'capped', verifier)).rejects.toMatchObject({
      code: 'too_early',
      details: { retryAfter: 60 },
    });
    const restarted = h.make();
    await expect(restarted.run({ transport: 'tor' }, undefined, 'restart', verifier)).rejects.toMatchObject({
      code: 'too_early',
    });
    await h.pass({}, cookie);
    expect((await h.row('global'))?.failures).toBe(30);
    h.clock.ms += 59_999;
    await expect(h.fail({ transport: 'tor' })).rejects.toMatchObject({ details: { retryAfter: 1 } });
    h.clock.ms++;
    await expect(h.fail({ transport: 'tor' })).rejects.toMatchObject({ code: 'login_failed' });
    expect((await h.row('global'))?.failures).toBe(1);
    expect(verifier).not.toHaveBeenCalled();
    await restarted.close();
  });

  it('rechecks the global cap for a queued attempt before its hash', async () => {
    const h = await harness();
    await h.db
      .insertInto('login_throttles')
      .values({
        counter: 'global',
        kind: 'global',
        failures: 29,
        next_allowed_at: h.clock.ms + 60_000,
        last_failed_at: h.clock.ms,
      })
      .execute();
    const entered = deferred();
    const finish = deferred();
    const first = h.throttle.run({ peerAddress: '192.0.2.1' }, undefined, 'first', async () => {
      entered.resolve();
      await finish.promise;
      return badLogin();
    });
    const firstOutcome = expect(first).rejects.toMatchObject({ code: 'login_failed' });
    await entered.promise;
    const verifier = vi.fn(badLogin);
    const queued = h.throttle.run({ peerAddress: '192.0.2.2' }, undefined, 'queued', verifier);
    const queuedOutcome = expect(queued).rejects.toMatchObject({ code: 'too_early' });
    finish.resolve();
    await Promise.all([firstOutcome, queuedOutcome]);
    expect(verifier).not.toHaveBeenCalled();
  });

  it('retains source penalties across restart and decays an idle counter exactly after 24 hours', async () => {
    const h = await harness();
    const cookie = await h.known();
    await expect(h.fail({}, cookie)).rejects.toMatchObject({ code: 'login_failed' });
    const restarted = h.make();
    await expect(restarted.run({}, cookie, 'restart', badLogin)).rejects.toMatchObject({ code: 'too_early' });
    h.clock.ms += COUNTER_DECAY_MS - 1;
    await expect(h.fail({}, cookie)).rejects.toMatchObject({ code: 'login_failed' });
    expect((await h.row(`device:${digest(cookie)}`))?.failures).toBe(2);
    h.clock.ms += COUNTER_DECAY_MS;
    await expect(h.fail({}, cookie)).rejects.toMatchObject({ code: 'login_failed' });
    expect((await h.row(`device:${digest(cookie)}`))?.failures).toBe(1);
    await restarted.close();
  });

  it('evicts oldest unknown rows, excludes queued claims, keeps global protection, and prunes decayed rows', async () => {
    const h = await harness();
    const origin = { peerAddress: '192.0.2.1' };
    const protectedCounter = directSource(origin, []).counter;
    h.raw.exec('BEGIN IMMEDIATE');
    const insert = h.raw.prepare('INSERT INTO login_throttles VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < UNKNOWN_COUNTER_LIMIT; i++)
      insert.run([
        i === 0 ? protectedCounter : `ip:${digest(String(i))}`,
        'ip',
        1,
        h.clock.ms - 1000,
        h.clock.ms - 100 + i,
      ]);
    insert.run(['device:expired', 'device', 1, h.clock.ms - 1000, h.clock.ms - COUNTER_DECAY_MS]);
    insert.run(['device:retained', 'device', 1, h.clock.ms + 1000, h.clock.ms]);
    insert.run(['global', 'global', 2, h.clock.ms + 60_000, h.clock.ms]);
    h.raw.exec('COMMIT');
    const entered = deferred();
    const finish = deferred();
    const queuedEntered = deferred();
    const queuedFinish = deferred();
    const first = h.throttle.run({ peerAddress: '198.51.100.1' }, undefined, 'first', async () => {
      entered.resolve();
      await finish.promise;
      return badLogin();
    });
    const firstOutcome = expect(first).rejects.toMatchObject({ code: 'login_failed' });
    await entered.promise;
    const queued = h.throttle.run(origin, undefined, 'queued', async () => {
      queuedEntered.resolve();
      await queuedFinish.promise;
    });
    finish.resolve();
    await firstOutcome;
    await queuedEntered.promise;
    expect(await h.row(protectedCounter)).toBeDefined();
    expect(await h.row(`ip:${digest('1')}`)).toBeUndefined();
    expect(await h.row('device:expired')).toBeUndefined();
    expect(await h.row('device:retained')).toBeDefined();
    expect((await h.row('global'))?.failures).toBe(3);
    const count = await h.db
      .selectFrom('login_throttles')
      .select(h.db.fn.count<number>('counter').as('count'))
      .where('kind', 'in', ['ip', 'tor'])
      .executeTakeFirstOrThrow();
    expect(count.count).toBe(UNKNOWN_COUNTER_LIMIT);
    queuedFinish.resolve();
    await queued;
  });

  it('releases claims on internal/storage errors without treating them as guesses', async () => {
    const h = await harness();
    await expect(
      h.throttle.run({}, undefined, 'internal', () => Promise.reject(new Error('internal'))),
    ).rejects.toThrow('internal');
    expect(await h.row('global')).toBeUndefined();
    h.raw.exec(
      "CREATE TRIGGER reject_global BEFORE INSERT ON login_throttles WHEN NEW.kind = 'global' BEGIN SELECT RAISE(ABORT, 'write failed'); END",
    );
    await expect(h.fail()).rejects.toThrow('write failed');
    h.raw.exec('DROP TRIGGER reject_global');
    expect(await h.row(directSource({}, []).counter)).toBeUndefined();
    await expect(h.fail()).rejects.toMatchObject({ code: 'login_failed' });
  });

  it('rejects queued/new attempts on shutdown and drains a running check before storage closes', async () => {
    const h = await harness();
    const entered = deferred();
    const finish = deferred();
    const first = h.throttle.run({ peerAddress: '192.0.2.1' }, undefined, 'first', async () => {
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    const queued = h.throttle.run({ peerAddress: '192.0.2.2' }, undefined, 'queued', vi.fn());
    const queuedOutcome = expect(queued).rejects.toMatchObject({ code: 'busy' });
    let closed = false;
    const closing = h.throttle.close().then(() => {
      closed = true;
    });
    expect(h.throttle.close()).toBe(h.throttle.close());
    await queuedOutcome;
    await expect(h.fail()).rejects.toMatchObject({ code: 'busy' });
    expect(closed).toBe(false);
    finish.resolve();
    await first;
    await closing;
    expect(closed).toBe(true);
  });
});
