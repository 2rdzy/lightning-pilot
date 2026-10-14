import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRaw, kyselyOf, type Driver } from '../../storage/db.ts';
import { migrate, MIGRATIONS_DIR } from '../../storage/migrate.ts';
import { tempDir } from '../../testing.ts';
import { DeviceListResponse } from '@lightning-pilot/core';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
describe.each(['node:sqlite', 'better-sqlite3'] as const)('WP08 migration on %s', (driver: Driver) => {
  it('preserves existing owner/session/device rows and gives devices independent public handles', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const prior = join(t.dir, 'prior');
    mkdirSync(prior);
    for (const file of readdirSync(MIGRATIONS_DIR).filter(
      (name) => name.endsWith('.sql') && name !== '20261014T1000_sessions_lifecycle.sql',
    ))
      copyFileSync(join(MIGRATIONS_DIR, file), join(prior, file));
    const raw = await openRaw(join(t.dir, 'db'), driver);
    migrate(raw, prior);
    const handle = randomUUID();
    const date = '2026-10-14T08:00:00.000Z';
    raw.prepare('INSERT INTO owner(id,password_hash,created_at) VALUES (1,?,?)').run(['original-hash', date]);
    raw
      .prepare(
        'INSERT INTO sessions(id_hash,handle,created_at,last_seen_at,expires_at,recovery_required) VALUES (?,?,?,?,?,1)',
      )
      .run(['session-digest', handle, date, date, '2026-10-21T08:00:00.000Z']);
    raw
      .prepare('INSERT INTO known_devices(id_hash,created_at,last_seen_at,expires_at,source) VALUES (?,?,?,?,?)')
      .run(['device-digest', date, date, '2027-10-14T08:00:00.000Z', 'tor']);
    expect(migrate(raw)).toEqual(['20261014T1000_sessions_lifecycle.sql']);
    const db = kyselyOf(raw);
    try {
      const owner = await db.selectFrom('owner').selectAll().executeTakeFirstOrThrow();
      expect(owner.password_hash).toBe('original-hash');
      const session = await db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();
      expect(session).toMatchObject({
        id_hash: 'session-digest',
        handle,
        created_at: date,
        recovery_required: 1,
        ended_at: null,
        source: 'unknown',
        step_up_failures: 0,
        step_up_retry_at: 0,
      });
      const device = await db.selectFrom('known_devices').selectAll().executeTakeFirstOrThrow();
      expect(device).toMatchObject({ id_hash: 'device-digest', source: 'tor', created_at: date });
      expect(
        DeviceListResponse.safeParse({
          items: [
            {
              id: device.handle,
              source: device.source,
              createdAt: date,
              lastUsedAt: date,
              expiresAt: device.expires_at,
            },
          ],
        }).success,
      ).toBe(true);
      await db
        .insertInto('known_devices')
        .values({ id_hash: 'second', created_at: date, last_seen_at: date, expires_at: device.expires_at })
        .execute();
      const second = await db
        .selectFrom('known_devices')
        .selectAll()
        .where('id_hash', '=', 'second')
        .executeTakeFirstOrThrow();
      expect(second.handle).not.toBe(device.handle);
      await expect(
        db.updateTable('sessions').set({ step_up_failures: 6 }).where('handle', '=', handle).execute(),
      ).rejects.toThrow();
      await expect(
        db.updateTable('sessions').set({ end_reason: 'unsupported' }).where('handle', '=', handle).execute(),
      ).rejects.toThrow();
      expect(migrate(raw)).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});
