import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAdapter } from '@lightning-pilot/adapter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../../logging/logger.ts';
import { loadConfig } from '../../../config/config.ts';
import { buildServer } from '../../../server.ts';
import { setupForTest, tempDir, testDriver, writeVaultKey } from '../../../testing.ts';
import { acquireServiceLock } from '../../setup/reset.ts';
import { resetLoginThrottles } from './reset.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const TABLES = [
  'owner',
  'auth_totp',
  'recovery_codes',
  'known_devices',
  'sessions',
  'settings',
  'nodes',
  'credentials',
  'spend_limits',
  'spend_intents',
] as const;

async function harness() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const vaultKey = writeVaultKey(t.dir);
  const configPath = join(t.dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: t.dir, vaultKey } }));
  const { config } = loadConfig({ argv: ['--config', configPath, '--dev'], env: {} });
  const logs: string[] = [];
  const logger = createLogger({ sink: (line) => logs.push(line) });
  const open = () =>
    buildServer({
      config,
      vaultKeyPath: vaultKey,
      dev: true,
      logger,
      driver: testDriver(),
      issueSetupToken: false,
      scryptCost: { log2N: 10, r: 8, p: 1 },
      adapterFactory: () => new FakeAdapter({ chain: 'blake2b', network: 'regtest' }),
    });
  let server = await open();
  await server.auth.issueSetupToken();
  const token = (JSON.parse(logs.find((line) => line.includes('"setupToken"')) ?? '{}') as { setupToken: string })
    .setupToken;
  await setupForTest(server.setup, token, 'Correct-horse-9-battery');
  const node = await server.nodes.add(
    {
      name: 'Synthetic',
      chain: 'blake2b',
      network: 'regtest',
      implementation: 'cln',
      url: 'https://localhost:1234',
      caCertificate: 'synthetic',
      viewRune: 'synthetic-view',
      serverName: 'localhost',
    },
    'reset',
  );
  const now = new Date().toISOString();
  await server.db
    .insertInto('spend_intents')
    .values({
      id: 'intent',
      node_id: node.id,
      chain: 'blake2b',
      pubkey: node.pubkey,
      type: 'bolt11',
      payment_hash: '00'.repeat(32),
      amount_msat: '1000',
      max_fee_msat: '10',
      fee_msat: null,
      state: 'unknown',
      idempotency_key: 'reset-test',
      digest: 'digest',
      error_code: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await server.db
    .insertInto('login_throttles')
    .values([
      { counter: 'ip:test', kind: 'ip', failures: 1, next_allowed_at: Date.now() + 1000, last_failed_at: Date.now() },
      {
        counter: 'device:test',
        kind: 'device',
        failures: 1,
        next_allowed_at: Date.now() + 1000,
        last_failed_at: Date.now(),
      },
      {
        counter: 'global',
        kind: 'global',
        failures: 30,
        next_allowed_at: Date.now() + 60_000,
        last_failed_at: Date.now(),
      },
    ])
    .execute();
  const snapshot = async () => Promise.all(TABLES.map((table) => server.db.selectFrom(table).selectAll().execute()));
  const before = await snapshot();
  let closed = false;
  const close = async () => {
    if (!closed) {
      await server.close();
      closed = true;
    }
  };
  cleanups.push(close);
  const reopen = async () => {
    await close();
    server = await open();
    closed = false;
    return server;
  };
  return { server, open, reopen, before, snapshot, configPath, logger, logs, close, vaultKey, dir: t.dir };
}

describe('offline login-throttle reset', () => {
  it('clears source/global penalties while retaining all other authentication, vault and unresolved-money data', async () => {
    const h = await harness();
    await resetLoginThrottles(h.server.db, h.logger);
    expect(await h.server.db.selectFrom('login_throttles').selectAll().execute()).toEqual([]);
    expect(await h.snapshot()).toEqual(h.before);
    expect(h.logs.some((line) => line.includes('login throttles reset') && line.includes('"security":true'))).toBe(
      true,
    );
  });

  it('runs the real locked CLI as the data owner without a listener, setup token or vault access', async () => {
    const h = await harness();
    await h.close();
    const backupKey = readFileSync(h.vaultKey);
    rmSync(h.vaultKey);
    const run = () =>
      spawnSync(
        process.execPath,
        [
          new URL('../../../main.ts', import.meta.url).pathname,
          'reset-login-throttles',
          '--config',
          h.configPath,
          '--dev',
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );
    const release = acquireServiceLock(h.dir);
    try {
      const locked = run();
      expect(locked.status).toBe(1);
      expect(locked.stderr).toContain('already running');
      expect(locked.stdout).not.toContain('setupToken');
    } finally {
      release();
    }
    const reset = run();
    expect(reset.status, reset.stderr).toBe(0);
    expect(reset.stdout).toContain('login throttles reset');
    expect(reset.stdout).not.toContain('setupToken');
    expect(reset.stdout).not.toContain('listening');
    writeFileSync(h.vaultKey, backupKey, { mode: 0o600 });
    const server = await h.reopen();
    expect(await server.db.selectFrom('login_throttles').selectAll().execute()).toEqual([]);
    expect(await h.snapshot()).toEqual(h.before);
  });
});
