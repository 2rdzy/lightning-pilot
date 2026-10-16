import { testRune } from '../../testing.ts';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAdapter } from '@lightning-pilot/adapter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../logging/logger.ts';
import { loadConfig } from '../../config/config.ts';
import { buildServer } from '../../server.ts';
import { setupForTest, tempDir, testDb, writeVaultKey } from '../../testing.ts';
import { AuthService } from '../auth/index.ts';
import { NodesService } from '../nodes/service.ts';
import { Vault } from '../vault/index.ts';
import { acquireServiceLock, requireDataOwner, resetAuth } from './reset.ts';
import { SetupService } from './service.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('offline authentication reset', () => {
  it('runs the real offline CLI with locking, token rotation and owner reset', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const vaultKey = writeVaultKey(t.dir);
    const configPath = join(t.dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: t.dir, vaultKey } }));
    const { config } = loadConfig({ argv: ['--config', configPath, '--dev'] });
    const tokens: string[] = [];
    const logger = createLogger({
      sink: () => {},
      stdout: (line) => {
        const entry = JSON.parse(line) as { setupToken?: string };
        if (entry.setupToken) tokens.push(entry.setupToken);
      },
    });
    const open = () =>
      buildServer({
        config,
        vaultKeyPath: vaultKey,
        dev: true,
        logger,
        issueSetupToken: false,
        scryptCost: { log2N: 10, r: 8, p: 1 },
        adapterFactory: () => new FakeAdapter({ chain: 'blake2b', network: 'regtest' }),
      });
    const run = (command: 'reset-auth' | 'setup-token') =>
      spawnSync(
        process.execPath,
        [new URL('../../main.ts', import.meta.url).pathname, command, '--config', configPath, '--dev'],
        { encoding: 'utf8', timeout: 15_000 },
      );
    const printedTokens = (stdout: string) =>
      stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { setupToken?: string })
        .flatMap((entry) => (entry.setupToken ? [entry.setupToken] : []));
    let server = await open();
    await server.auth.issueSetupToken();
    await server.close();
    const release = acquireServiceLock(t.dir);
    try {
      const locked = run('reset-auth');
      expect(locked.status).toBe(1);
      expect(locked.stderr, JSON.stringify(locked)).toContain('already running');
      expect(printedTokens(locked.stdout)).toEqual([]);
    } finally {
      release();
    }
    const rotation = run('setup-token');
    expect(rotation.status, rotation.stderr).toBe(0);
    const rotated = printedTokens(rotation.stdout);
    expect(rotated).toHaveLength(1);
    expect(rotated[0]).not.toBe(tokens[0]);
    server = await open();
    try {
      const storedToken = await server.db.selectFrom('setup_token').select('token_hash').executeTakeFirstOrThrow();
      expect(storedToken.token_hash).not.toBe(
        createHash('sha256')
          .update((tokens[0] ?? '').replace(/-/g, ''))
          .digest('hex'),
      );
      await setupForTest(server.setup, rotated[0] ?? '', 'Correct-horse-9-battery');
      await server.nodes.add(
        {
          name: 'Synthetic',
          chain: 'blake2b',
          network: 'regtest',
          implementation: 'cln',
          url: 'https://localhost:1234',
          caCertificate: 'synthetic',
          viewRune: testRune('read'),
          serverName: 'localhost',
        },
        'r-cli',
      );
    } finally {
      await server.close();
    }
    const ownerToken = run('setup-token');
    expect(ownerToken.status).toBe(1);
    expect(ownerToken.stderr).toContain('already been completed');
    expect(printedTokens(ownerToken.stdout)).toEqual([]);
    server = await open();
    const before = {
      keyId: (
        await server.db
          .selectFrom('settings')
          .select('value')
          .where('key', '=', 'vault_key_id')
          .executeTakeFirstOrThrow()
      ).value,
      nodes: await server.db.selectFrom('nodes').selectAll().execute(),
      credentials: await server.db.selectFrom('credentials').selectAll().execute(),
    };
    await server.close();
    const reset = run('reset-auth');
    expect(reset.status, reset.stderr).toBe(0);
    expect(printedTokens(reset.stdout)).toHaveLength(1);
    server = await open();
    try {
      expect(server.auth.setupMode).toBe(true);
      expect(
        (
          await server.db
            .selectFrom('settings')
            .select('value')
            .where('key', '=', 'vault_key_id')
            .executeTakeFirstOrThrow()
        ).value,
      ).toBe(before.keyId);
      expect(
        await server.db.selectFrom('settings').select('value').where('key', '=', 'vault_canary').executeTakeFirst(),
      ).toBeDefined();
      expect(await server.db.selectFrom('nodes').selectAll().execute()).toEqual(before.nodes);
      expect(await server.db.selectFrom('credentials').selectAll().execute()).toEqual(before.credentials);
      expect(await server.db.selectFrom('auth_totp').selectAll().execute()).toEqual([]);
      expect(await server.db.selectFrom('sessions').selectAll().execute()).toEqual([]);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('deletes authentication state while preserving credentials, nodes, limits, settings and history', async () => {
    const t = tempDir();
    const { db, raw } = await testDb(t.dir);
    cleanups.push(async () => {
      await db.destroy();
      t.cleanup();
    });
    const now = new Date('2026-10-13T12:00:00Z');
    const timestamp = now.toISOString();
    const tokens: string[] = [];
    const events: string[] = [];
    const logger = createLogger({
      sink: (l) => events.push(l),
      stdout: (l) => {
        const p = JSON.parse(l) as { setupToken?: string };
        if (p.setupToken) tokens.push(p.setupToken);
      },
    });
    const vault = await Vault.start(db, randomBytes(32));
    const auth = await AuthService.create({
      db,
      raw,
      vault,
      logger,
      setupUrl: 'https://localhost/setup',
      scryptCost: { log2N: 10, r: 8, p: 1 },
      now: () => now,
    });
    const nodes = new NodesService({
      db,
      vault,
      logger,
      dev: true,
      maxNodes: 5,
      adapterFactory: () => new FakeAdapter({ chain: 'blake2b', network: 'regtest' }),
    });
    const setup = new SetupService({
      db,
      vault,
      auth,
      nodes,
      logger,
      scryptCost: { log2N: 10, r: 8, p: 1 },
      now: () => now,
    });
    cleanups.push(async () => {
      setup.close();
      await nodes.monitor.stop();
    });
    await auth.issueSetupToken();
    const firstToken = tokens[0];
    if (!firstToken) throw new Error('No token');
    await setupForTest(setup, firstToken, 'Correct-horse-9-battery', now);
    await db
      .insertInto('nodes')
      .values({
        id: 'node',
        name: 'Synthetic',
        chain: 'blake2b',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://localhost:1234',
        ca_certificate: 'synthetic',
        server_name: 'localhost',
        pubkey: '02' + 'a'.repeat(64),
        identity_state: 'confirmed',
        identity_failed_check: null,
        identity_detail: null,
        identity_checked_at: timestamp,
        created_at: timestamp,
      })
      .execute();
    await vault.put(db, 'node', 'read', testRune('read'));
    await db
      .insertInto('spend_limits')
      .values({
        chain: 'blake2b',
        pubkey: '02' + 'a'.repeat(64),
        max_per_payment_sat: '100',
        max_24h_sat: '200',
        step_up_above_sat: null,
        max_fee_rate: '3',
        max_fee_share_percent: 5,
        max_routing_fee_share_percent: 1,
        routing_fee_allowance_sat: '10',
      })
      .execute();
    await db
      .insertInto('spend_intents')
      .values({
        id: 'intent',
        node_id: 'node',
        chain: 'blake2b',
        pubkey: '02' + 'a'.repeat(64),
        type: 'bolt11',
        payment_hash: 'hash',
        amount_msat: '1000',
        max_fee_msat: '10',
        fee_msat: null,
        state: 'failed',
        idempotency_key: 'key',
        digest: 'digest',
        error_code: null,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .execute();
    const before = {
      nodes: await db.selectFrom('nodes').selectAll().execute(),
      credentials: await db.selectFrom('credentials').selectAll().execute(),
      limits: await db.selectFrom('spend_limits').selectAll().execute(),
      settings: await db.selectFrom('settings').selectAll().execute(),
      history: await db.selectFrom('spend_intents').selectAll().execute(),
    };
    await db
      .insertInto('login_throttles')
      .values({
        counter: 'global',
        kind: 'global',
        failures: 30,
        next_allowed_at: now.getTime() + 60000,
        last_failed_at: now.getTime(),
      })
      .execute();
    await resetAuth(db, logger);
    await auth.resetState();
    for (const table of [
      'owner',
      'auth_totp',
      'recovery_codes',
      'known_devices',
      'login_throttles',
      'sessions',
    ] as const)
      expect(await db.selectFrom(table).selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('nodes').selectAll().execute()).toEqual(before.nodes);
    expect(await db.selectFrom('credentials').selectAll().execute()).toEqual(before.credentials);
    expect(await db.selectFrom('spend_limits').selectAll().execute()).toEqual(before.limits);
    expect(await db.selectFrom('settings').selectAll().execute()).toEqual(before.settings);
    expect(await db.selectFrom('spend_intents').selectAll().execute()).toEqual(before.history);
    expect(auth.setupMode).toBe(true);
    expect(vault.initialised).toBe(true);
    expect(events.some((l) => l.includes('authentication reset'))).toBe(true);
    const freshToken = tokens[1];
    if (!freshToken) throw new Error('No new token');
    expect(freshToken).not.toBe(firstToken);
    expect(
      (await setup.act({ action: 'start', token: freshToken }, undefined, undefined, 'reset-test')).progress.step,
    ).toBe('password');
  });

  it('locks out a concurrent launcher and releases the lock on close', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const release = acquireServiceLock(t.dir);
    try {
      expect(() => acquireServiceLock(t.dir)).toThrow('already running');
    } finally {
      release();
    }
    const secondRelease = acquireServiceLock(t.dir);
    secondRelease();
  });

  it('requires an existing database owned by the service user', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    expect(() => requireDataOwner(t.dir)).toThrow('No existing database');
    writeFileSync(join(t.dir, 'lightning-pilot.db'), '');
    expect(() => requireDataOwner(t.dir)).not.toThrow();
    if (process.getuid) {
      const realUid = process.getuid();
      const uid = vi.spyOn(process, 'getuid').mockReturnValue(realUid + 1);
      try {
        expect(() => requireDataOwner(t.dir)).toThrow('service user');
      } finally {
        uid.mockRestore();
      }
    }
  });
});
