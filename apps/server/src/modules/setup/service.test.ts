import { testRune } from '../../testing.ts';
import { randomBytes } from 'node:crypto';
import { FakeAdapter } from '@lightning-pilot/adapter-kit';
import { AdapterError, type SetupAction, type SetupLimits } from '@lightning-pilot/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../logging/logger.ts';
import { tempDir, testDb } from '../../testing.ts';
import { AuthService, type LoginOrigin } from '../auth/index.ts';
import { totp } from '../auth/totp/totp.ts';
import { NodesService } from '../nodes/service.ts';
import { Vault } from '../vault/index.ts';
import { SetupService } from './service.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const PASSWORD = 'Correct-horse-9-battery';
const COST = { log2N: 10, r: 8, p: 1 };
const INPUT = {
  name: 'Synthetic',
  implementation: 'cln' as const,
  chain: 'blake2b' as const,
  network: 'regtest' as const,
  url: 'https://localhost:1234',
  caCertificate: 'synthetic certificate',
  serverName: 'localhost',
  viewRune: testRune('read'),
  spendRune: testRune('spend'),
};
const ATTACKER = { peerAddress: '203.0.113.9' };
const OWNER = { peerAddress: '192.0.2.5' };
const LIMITS: SetupLimits = {
  maxPerPayment: '100',
  max24h: '200',
  stepUpAbove: '50',
  maxFeeRate: '3',
  maxFeeSharePercent: 5,
  maxRoutingFeeSharePercent: 1,
  routingFeeAllowance: '10',
};

async function harness() {
  const t = tempDir();
  const { db, raw } = await testDb(t.dir);
  const clock = { now: new Date('2026-10-13T12:00:00Z') };
  const lines: string[] = [];
  const tokens: string[] = [];
  const logger = createLogger({
    sink: (l) => lines.push(l),
    stdout: (l) => {
      const parsed = JSON.parse(l) as { setupToken?: string };
      if (parsed.setupToken) tokens.push(parsed.setupToken);
    },
  });
  const vault = await Vault.start(db, randomBytes(32));
  const auth = await AuthService.create({
    db,
    raw,
    vault,
    logger,
    setupUrl: 'https://localhost/setup',
    scryptCost: COST,
    now: () => clock.now,
  });
  await auth.issueSetupToken();
  const fake = new FakeAdapter({ chain: 'blake2b', network: 'regtest' });
  const nodes = new NodesService({
    db,
    vault,
    logger,
    dev: true,
    maxNodes: 5,
    adapterFactory: () => fake,
    now: () => clock.now,
  });
  const options = { db, vault, auth, nodes, logger, scryptCost: COST, now: () => clock.now };
  const setup = new SetupService(options);
  cleanups.push(async () => {
    setup.close();
    await nodes.monitor.stop();
    await db.destroy();
    t.cleanup();
  });
  const token = tokens[0];
  if (!token) throw new Error('Missing setup token');
  const start = await setup.act({ action: 'start', token }, undefined, undefined, 'test');
  const cookie = start.cookie;
  const csrf = start.progress.csrfToken;
  const act = (action: SetupAction) => setup.act(action, cookie, csrf, 'test');
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  const enrol = async () => {
    const password = await act({ action: 'password', password: PASSWORD });
    const secret = password.progress.secret;
    if (!secret) throw new Error('Missing TOTP secret');
    const recovery = await act({ action: 'totp', code: totp(secret, clock.now) });
    const code = recovery.progress.recoveryCodes?.[0];
    if (!code) throw new Error('Missing recovery code');
    await act({ action: 'recovery', code });
    await act({ action: 'backup', confirmed: true });
    return { secret, code, recovery };
  };
  const complete = async () => {
    await enrol();
    await act({ action: 'node', node: null });
    await act({ action: 'alerts', alerts: { kind: 'none' } });
    return act({ action: 'complete' });
  };
  return {
    db,
    clock,
    lines,
    tokens,
    vault,
    auth,
    fake,
    nodes,
    setup,
    options,
    token,
    cookie,
    csrf,
    act,
    start,
    advance,
    enrol,
    complete,
  };
}

describe('first-run setup service', () => {
  it('enforces step order, CSRF, browser binding and exclusive ownership', async () => {
    const h = await harness();
    await expect(h.act({ action: 'complete' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      h.setup.act({ action: 'password', password: PASSWORD }, h.cookie, undefined, 't'),
    ).rejects.toMatchObject({ code: 'csrf_failed' });
    await expect(h.setup.act({ action: 'cancel' }, 'other', h.csrf, 't')).rejects.toMatchObject({
      code: 'setup_token_invalid',
    });
    await expect(h.setup.act({ action: 'start', token: h.token }, undefined, undefined, 't')).rejects.toMatchObject({
      code: 'busy',
    });
    const resume = await h.setup.act({ action: 'start', token: h.token }, h.cookie, undefined, 't');
    expect(resume.cookie).toBe(h.cookie);
    expect(resume.progress.secret).toBeUndefined();
    await h.act({ action: 'cancel' });
    await expect(h.act({ action: 'password', password: PASSWORD })).rejects.toMatchObject({
      code: 'setup_token_invalid',
    });
    expect((await h.setup.act({ action: 'start', token: h.token }, undefined, undefined, 't')).progress.step).toBe(
      'password',
    );
  });

  it('expires idle drafts, refreshes active expiry, and respects token lifetime', async () => {
    const h = await harness();
    h.advance(14 * 60_000);
    const p = await h.act({ action: 'password', password: PASSWORD });
    expect(p.cookie).toBe(h.cookie);
    expect(Date.parse(p.progress.expiresAt)).toBe(h.clock.now.getTime() + 15 * 60_000);
    h.advance(15 * 60_000);
    await expect(h.act({ action: 'cancel' })).rejects.toMatchObject({ code: 'setup_token_invalid' });
    h.advance(24 * 60 * 60_000);
    await expect(h.setup.act({ action: 'start', token: h.token }, undefined, undefined, 't')).rejects.toMatchObject({
      code: 'setup_token_invalid',
    });
  });

  it('rejects old tokens and browser sessions after restart', async () => {
    const h = await harness();
    h.setup.close();
    await h.auth.issueSetupToken();
    const next = new SetupService(h.options);
    await expect(next.act({ action: 'cancel' }, h.cookie, h.csrf, 't')).rejects.toMatchObject({
      code: 'setup_token_invalid',
    });
    await expect(next.act({ action: 'start', token: h.token }, undefined, undefined, 't')).rejects.toMatchObject({
      code: 'setup_token_invalid',
    });
    next.close();
  });

  it('doubles token delays to a 15-minute cap with separate source counters', async () => {
    const h = await harness();
    for (let i = 0; i < 12; i++) {
      await expect(
        h.setup.act({ action: 'start', token: 'wrong' }, undefined, undefined, 't', ATTACKER),
      ).rejects.toMatchObject({ code: 'setup_token_invalid' });
      const seconds = Math.min(2 ** i, 900);
      await expect(
        h.setup.act({ action: 'start', token: 'wrong' }, undefined, undefined, 't', ATTACKER),
      ).rejects.toMatchObject({ code: 'too_early', details: { retryAfter: seconds } });
      h.advance(seconds * 1000);
    }
    expect(
      (await h.setup.act({ action: 'start', token: h.token }, undefined, undefined, 't', OWNER)).progress.step,
    ).toBe('password');
  });

  it('requires proof of TOTP and a saved recovery code, exposing each only at enrolment', async () => {
    const h = await harness();
    const p = await h.act({ action: 'password', password: PASSWORD });
    const secret = p.progress.secret;
    if (!secret) throw new Error('Missing secret');
    const correct = totp(secret, h.clock.now);
    const wrong = correct === '000000' ? '111111' : '000000';
    await expect(h.act({ action: 'totp', code: wrong })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(h.act({ action: 'totp', code: correct })).rejects.toMatchObject({ code: 'too_early' });
    h.advance(1000);
    const r = await h.act({ action: 'totp', code: totp(secret, h.clock.now) });
    expect(r.progress.recoveryCodes).toHaveLength(10);
    await expect(h.act({ action: 'recovery', code: 'ABCD-EFGH-IJKL-MNOP' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    const code = r.progress.recoveryCodes?.[0];
    if (!code) throw new Error('Missing recovery code');
    const b = await h.act({ action: 'recovery', code });
    expect(b.progress.secret).toBeUndefined();
    expect(b.progress.recoveryCodes).toBeUndefined();
    await expect(h.act({ action: 'node', node: null })).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await h.db.selectFrom('owner').selectAll().execute()).toEqual([]);
  });

  it('atomically completes without a node and stores hashed codes and encrypted factors', async () => {
    const h = await harness();
    const result = await h.complete();
    expect(result.progress.step).toBe('done');
    expect(result.sessionCookie).toBeTruthy();
    expect(result.deviceCookie).toBeTruthy();
    expect(h.auth.setupMode).toBe(false);
    expect(await h.db.selectFrom('setup_token').selectAll().execute()).toEqual([]);
    expect(await h.db.selectFrom('nodes').selectAll().execute()).toEqual([]);
    const codes = await h.db.selectFrom('recovery_codes').selectAll().execute();
    expect(codes).toHaveLength(10);
    expect(codes.every((c) => /^[a-f0-9]{64}$/.test(c.code_hash) && c.used_at === null)).toBe(true);
    expect(await h.db.selectFrom('known_devices').selectAll().execute()).toHaveLength(1);
    expect(await h.db.selectFrom('auth_totp').selectAll().execute()).toHaveLength(1);
    await expect(h.act({ action: 'complete' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('checks chain identity and permits retrying only the optional node stage', async () => {
    const h = await harness();
    await h.enrol();
    await expect(h.act({ action: 'node', node: { ...INPUT, chain: 'bitcoin' } })).rejects.toMatchObject({
      code: 'chain_refused',
    });
    expect((await h.act({ action: 'node', node: null })).progress.step).toBe('alerts');
  });

  it.each(['admin', 'full'] as const)('refuses %s credentials', async (level) => {
    const h = await harness();
    await h.enrol();
    const status = await h.fake.node.getStatus();
    vi.spyOn(h.fake.node, 'getStatus').mockResolvedValue({ ...status, accessLevel: level });
    await expect(h.act({ action: 'node', node: INPUT })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('refuses revoked credentials on addition and rechecks them at completion', async () => {
    const h = await harness();
    await h.enrol();
    const status = await h.fake.node.getStatus();
    const mock = vi.spyOn(h.fake.node, 'getStatus').mockResolvedValue({ ...status, credential: 'revoked' });
    await expect(h.act({ action: 'node', node: INPUT })).rejects.toMatchObject({ code: 'node_credential_revoked' });
    mock.mockResolvedValue(status);
    const n = await h.act({ action: 'node', node: INPUT });
    expect(n.progress.defaultLimits?.maxFeeRate).toBeTruthy();
    await h.act({ action: 'limits', limits: LIMITS });
    await h.act({ action: 'alerts', alerts: { kind: 'none' } });
    mock.mockResolvedValue({ ...status, credential: 'revoked' });
    await expect(h.act({ action: 'complete' })).rejects.toMatchObject({ code: 'node_credential_revoked' });
    expect(await h.db.selectFrom('owner').selectAll().execute()).toEqual([]);
  });

  it('accepts narrower read credentials without estimates and requires explicit limits', async () => {
    const h = await harness();
    await h.enrol();
    vi.spyOn(h.fake.chain, 'getFeeEstimates').mockRejectedValue(
      new AdapterError({ code: 'permission_denied', sent: false, definitive: true }),
    );
    const n = await h.act({ action: 'node', node: INPUT });
    expect(n.progress.feeEstimateAvailable).toBe(false);
    expect(n.progress.defaultLimits).toBeUndefined();
    await expect(h.act({ action: 'alerts', alerts: { kind: 'none' } })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await h.act({ action: 'limits', limits: LIMITS });
    await h.act({ action: 'alerts', alerts: { kind: 'none' } });
    await h.act({ action: 'complete' });
    expect(await h.db.selectFrom('spend_limits').selectAll().executeTakeFirst()).toMatchObject({
      max_per_payment_sat: '100',
      max_fee_rate: '3',
    });
  });

  it.each(['0', '9999999'])('rejects unusable fee estimate %s before stage advancement', async (fastest) => {
    const h = await harness();
    await h.enrol();
    const fees = await h.fake.chain.getFeeEstimates();
    vi.spyOn(h.fake.chain, 'getFeeEstimates').mockResolvedValue({ ...fees, rates: { ...fees.rates, fastest } });
    await expect(h.act({ action: 'node', node: INPUT })).rejects.toMatchObject({ code: 'node_bad_response' });
    expect((await h.act({ action: 'node', node: null })).progress.step).toBe('alerts');
  });

  it('rolls back every setup write and canary state on final transaction failure', async () => {
    const h = await harness();
    await h.enrol();
    await h.act({ action: 'node', node: INPUT });
    await h.act({ action: 'limits', limits: LIMITS });
    await h.act({ action: 'alerts', alerts: { kind: 'none' } });
    vi.spyOn(h.nodes, 'storePrepared').mockRejectedValue(new Error('injected storage failure'));
    await expect(h.act({ action: 'complete' })).rejects.toThrow('injected storage failure');
    for (const table of ['owner', 'auth_totp', 'recovery_codes', 'known_devices', 'nodes', 'sessions'] as const)
      expect(await h.db.selectFrom(table).selectAll().execute()).toEqual([]);
    expect(await h.db.selectFrom('settings').selectAll().where('key', '=', 'vault_canary').execute()).toEqual([]);
    expect(h.vault.initialised).toBe(false);
    expect(h.auth.setupMode).toBe(true);
    expect(await h.db.selectFrom('setup_token').selectAll().execute()).toHaveLength(1);
  });

  it('refuses competing setup mutations while a node admission is pending', async () => {
    const h = await harness();
    await h.enrol();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = h.nodes.prepare.bind(h.nodes);
    vi.spyOn(h.nodes, 'prepare').mockImplementation(async (input, requestId) => {
      await gate;
      return original(input, requestId);
    });
    const pending = h.act({ action: 'node', node: INPUT });
    await expect(h.act({ action: 'cancel' })).rejects.toMatchObject({ code: 'busy' });
    if (!release) throw new Error('Missing gate');
    release();
    await pending;
  });

  it('refuses completion if its setup token was rotated or another owner appeared', async () => {
    const h = await harness();
    await h.enrol();
    await h.act({ action: 'node', node: null });
    await h.act({ action: 'alerts', alerts: { kind: 'none' } });
    await h.auth.issueSetupToken();
    await expect(h.act({ action: 'complete' })).rejects.toMatchObject({ code: 'setup_token_invalid' });
    await h.act({ action: 'cancel' });
    const fresh = h.tokens[1];
    if (!fresh) throw new Error('Missing new token');
    const start = await h.setup.act({ action: 'start', token: fresh }, undefined, undefined, 'test');
    const act = (action: SetupAction) => h.setup.act(action, start.cookie, start.progress.csrfToken, 'test');
    const password = await act({ action: 'password', password: PASSWORD });
    const secret = password.progress.secret;
    if (!secret) throw new Error('No secret');
    const recovery = await act({ action: 'totp', code: totp(secret, h.clock.now) });
    const code = recovery.progress.recoveryCodes?.[0];
    if (!code) throw new Error('No recovery');
    await act({ action: 'recovery', code });
    await act({ action: 'backup', confirmed: true });
    await act({ action: 'node', node: null });
    await act({ action: 'alerts', alerts: { kind: 'none' } });
    await h.db
      .insertInto('owner')
      .values({ id: 1, password_hash: 'existing', created_at: h.clock.now.toISOString() })
      .execute();
    await expect(act({ action: 'complete' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await h.db.selectFrom('recovery_codes').selectAll().execute()).toEqual([]);
  });

  it('keeps setup-token counters in the database, grouped like login sources', async () => {
    const h = await harness();
    const start = (origin: LoginOrigin, token = 'wrong') =>
      h.setup.act({ action: 'start', token }, undefined, undefined, 't', origin);
    await expect(start({ peerAddress: '2001:db8:1:2::1' })).rejects.toMatchObject({ code: 'setup_token_invalid' });
    // Another address in the same IPv6 /64 shares the counter.
    await expect(start({ peerAddress: '2001:db8:1:2::ffff' })).rejects.toMatchObject({ code: 'too_early' });
    // Another network does not.
    await expect(start({ peerAddress: '2001:db8:1:3::1' })).rejects.toMatchObject({ code: 'setup_token_invalid' });
    // The Tor listener has one shared counter, whatever the peer address says.
    await expect(start({ transport: 'tor', peerAddress: '127.0.0.1' })).rejects.toMatchObject({
      code: 'setup_token_invalid',
    });
    await expect(start({ transport: 'tor', peerAddress: '127.0.0.2' })).rejects.toMatchObject({ code: 'too_early' });
    const rows = await h.db.selectFrom('login_throttles').select(['kind', 'failures']).execute();
    expect(rows).toEqual(Array.from({ length: 3 }, () => ({ kind: 'setup', failures: 1 })));
    expect(
      h.lines.some((line) => line.includes('"setup token refused"') && line.includes('2001:0db8:0001:0002::/64')),
    ).toBe(true);
    // A fresh service (as after a restart) reads the same counters.
    const again = new SetupService(h.options);
    await expect(
      again.act({ action: 'start', token: 'wrong' }, undefined, undefined, 't', { peerAddress: '2001:db8:1:2::1' }),
    ).rejects.toMatchObject({ code: 'too_early' });
    again.close();
    // The right token from a counted source, once allowed, starts setup and clears that source's counter.
    await h.act({ action: 'cancel' });
    h.advance(1000);
    expect((await start({ peerAddress: '2001:db8:1:3::9' }, h.token)).progress.step).toBe('password');
    expect(await h.db.selectFrom('login_throttles').select('counter').execute()).toHaveLength(2);
  });

  it('refuses a second setup-token check from the same source while one is running', async () => {
    const h = await harness();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const origin = { peerAddress: '192.0.2.44' };
    const verify = vi.fn(async () => {
      await gate;
      return undefined;
    });
    const first = h.auth.setupAttempt(origin, 'one', verify);
    await expect(h.auth.setupAttempt(origin, 'two', verify)).rejects.toMatchObject({ code: 'too_early' });
    release();
    await expect(first).rejects.toMatchObject({ code: 'setup_token_invalid' });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('refuses limits that could never take effect', async () => {
    const h = await harness();
    await h.enrol();
    await h.act({ action: 'node', node: INPUT });
    const order = (limits: Partial<SetupLimits>) => h.act({ action: 'limits', limits: { ...LIMITS, ...limits } });
    await expect(order({ maxPerPayment: '300' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(order({ stepUpAbove: '150' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(order({ maxPerPayment: null, stepUpAbove: '250' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect((await order({ maxPerPayment: null, max24h: null, stepUpAbove: '999999' })).progress.step).toBe('alerts');
  });

  it('propagates unavailable node fee estimates without advancing the node step', async () => {
    const h = await harness();
    await h.enrol();
    vi.spyOn(h.fake.chain, 'getFeeEstimates').mockRejectedValue(
      new AdapterError({ code: 'node_unreachable', sent: false, definitive: true }),
    );
    await expect(h.act({ action: 'node', node: INPUT })).rejects.toMatchObject({ code: 'node_unreachable' });
    expect((await h.act({ action: 'node', node: null })).progress.step).toBe('alerts');
  });

  it('encrypts pending Telegram credentials and never writes plaintext to settings or logs', async () => {
    const h = await harness();
    await h.enrol();
    await h.act({ action: 'node', node: null });
    const botToken = '123456:' + 'A'.repeat(35);
    await h.act({ action: 'alerts', alerts: { kind: 'telegram', botToken } });
    await h.act({ action: 'complete' });
    const row = await h.db
      .selectFrom('settings')
      .selectAll()
      .where('key', '=', 'setup_alerts')
      .executeTakeFirstOrThrow();
    expect(row.value).not.toContain(botToken);
    expect(JSON.parse(row.value)).toMatchObject({ kind: 'telegram', pending: true });
    expect(h.lines.join('\n')).not.toContain(botToken);
  });
});

describe('spending-choice database invariants', () => {
  it('refuses noncanonical amounts even when bypassing API validation', async () => {
    const { db } = await harness();
    const row = {
      chain: 'blake2b',
      pubkey: 'synthetic-pubkey',
      max_per_payment_sat: null,
      max_24h_sat: null,
      step_up_above_sat: null,
      max_fee_rate: '3',
      max_fee_share_percent: 5,
      max_routing_fee_share_percent: 1,
      routing_fee_allowance_sat: '0',
    };
    const fields = ['max_per_payment_sat', 'max_24h_sat', 'step_up_above_sat', 'routing_fee_allowance_sat'] as const;
    for (const field of fields) {
      for (const amount of ['00', '-1', '1.0', 'abc', '', '1000000000000000000']) {
        await expect(
          db
            .insertInto('spend_limits')
            .values({ ...row, [field]: amount })
            .execute(),
        ).rejects.toThrow(/CHECK constraint failed/);
      }
    }
    expect(await db.selectFrom('spend_limits').selectAll().execute()).toEqual([]);
    for (const amount of ['0', '1', '999999999999999999']) {
      await db
        .insertInto('spend_limits')
        .values({
          ...row,
          pubkey: `valid-${amount}`,
          max_per_payment_sat: amount,
          max_24h_sat: amount,
          step_up_above_sat: amount,
          routing_fee_allowance_sat: amount,
        })
        .execute();
    }
    await db.insertInto('spend_limits').values(row).execute();
    expect(await db.selectFrom('spend_limits').selectAll().execute()).toHaveLength(4);
    await expect(
      db
        .insertInto('spend_limits')
        .values({ ...row, pubkey: 'invalid-null-allowance', routing_fee_allowance_sat: null as unknown as string })
        .execute(),
    ).rejects.toThrow(/NOT NULL constraint failed/);
  });
});
