import { runeRestrictions } from '@lightning-pilot/adapter-cln';
// Test helpers shared by the server's tests (not used at run time).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kyselyOf, openRaw, type Driver } from './storage/db.ts';
import { migrate } from './storage/migrate.ts';

// The test job runs the server's tests a second time on better-sqlite3 (TEST_SQLITE_DRIVER=better-sqlite3).
export const testDriver = (): Driver =>
  process.env.TEST_SQLITE_DRIVER === 'better-sqlite3' ? 'better-sqlite3' : 'node:sqlite';

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lp-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function testDb(dir: string) {
  const raw = await openRaw(join(dir, 'test.db'), testDriver());
  migrate(raw);
  return { raw, db: kyselyOf(raw) };
}

export function writeVaultKey(dir: string, key: Buffer = randomBytes(32)): string {
  const path = join(dir, 'vault-key');
  writeFileSync(path, key.toString('hex') + '\n', { mode: 0o600 });
  return path;
}

// Completes the actual wizard for tests of other modules. Uses the previous TOTP window, leaving the current code
// available for a subsequent login. Setup-route tests exercise cookies/CSRF separately over HTTP.
export async function setupForTest(
  setup: import('./modules/setup/service.ts').SetupService,
  token: string,
  password: string,
  now?: Date,
) {
  let result = await setup.act({ action: 'start', token }, undefined, undefined, 'r-test');
  const cookie = result.cookie;
  const csrf = result.progress.csrfToken;
  const act = (action: import('@lightning-pilot/core').SetupAction) => setup.act(action, cookie, csrf, 'r-test');
  result = await act({ action: 'password', password });
  const secret = result.progress.secret;
  if (!secret) throw new Error('No enrolment secret');
  const { totp } = await import('./modules/auth/totp/totp.ts');
  const proofTime = now ?? new Date();
  try {
    result = await act({ action: 'totp', code: totp(secret, new Date(proofTime.getTime() - 30_000)) });
  } catch (error) {
    // Preserve the current counter for a later login. Only retry if real time crossed a TOTP window during setup.
    const current = new Date();
    if (now !== undefined || Math.floor(current.getTime() / 30_000) === Math.floor(proofTime.getTime() / 30_000))
      throw error;
    result = await act({ action: 'totp', code: totp(secret, new Date(current.getTime() - 30_000)) });
  }
  const code = result.progress.recoveryCodes?.[0];
  if (!code) throw new Error('No recovery code');
  await act({ action: 'recovery', code });
  await act({ action: 'backup', confirmed: true });
  await act({ action: 'node', node: null });
  await act({ action: 'alerts', alerts: { kind: 'none' } });
  return { secret, reply: await act({ action: 'complete' }) };
}

export function testRune(kind: 'read' | 'spend'): string {
  const clauses = JSON.parse(runeRestrictions(kind)) as string[][];
  return Buffer.concat([
    Buffer.alloc(32, kind === 'read' ? 1 : 2),
    Buffer.from('=1&' + clauses.map((c) => c.join('|')).join('&')),
  ]).toString('base64url');
}

export const testSpendPolicy = {
  maxPerPayment: null,
  max24h: null,
  stepUpAbove: null,
  maxFeeRate: '10',
  maxFeeSharePercent: 5,
  maxRoutingFeeSharePercent: 1,
  routingFeeAllowance: '10',
};
