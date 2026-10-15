import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_REQUEST_BYTES } from '@lightning-pilot/core';
import { loadConfig } from '../../config/config.ts';
import { createLogger } from '../../logging/logger.ts';
import { buildServer } from '../../server.ts';
import { setupForTest, tempDir, testDriver, writeVaultKey } from '../../testing.ts';
import { totp } from '../auth/totp/totp.ts';

const PASSWORD = 'Synthetic-Export-HTTP-Password-123!';
const PASS = 'a long synthetic export passphrase';
const BODY = { passphrase: PASS, passphraseConfirmation: PASS };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function harness() {
  const t = tempDir();
  const key = writeVaultKey(t.dir);
  const logs: string[] = [];
  const clock = { now: new Date('2026-10-15T12:00:00.000Z') };
  const { config } = loadConfig({
    env: {},
    readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: t.dir, vaultKey: key } }),
  });
  const server = await buildServer({
    config,
    vaultKeyPath: key,
    dev: true,
    driver: testDriver(),
    logger: createLogger({ sink: (line) => logs.push(line) }),
    now: () => clock.now,
    scryptCost: { log2N: 10, r: 8, p: 1 },
  });
  cleanups.push(async () => {
    await server.close();
    t.cleanup();
  });
  const token = (JSON.parse(logs.find((line) => line.includes('"setupToken"')) ?? '{}') as { setupToken: string })
    .setupToken;
  const enrolled = await setupForTest(server.setup, token, PASSWORD, clock.now);
  const auth = { cookie: enrolled.reply.sessionCookie ?? '', csrf: enrolled.reply.progress.session?.csrfToken ?? '' };
  const request = (path: string, body: unknown, headers: Record<string, string> = {}, raw = false) =>
    Promise.resolve(
      server.app.request(path, {
        method: 'POST',
        headers: {
          host: 'localhost',
          origin: 'https://localhost',
          cookie: `__Host-lp_session=${auth.cookie}`,
          'x-csrf-token': auth.csrf,
          'content-type': 'application/json',
          ...headers,
        },
        body: raw ? String(body) : JSON.stringify(body),
      }),
    );
  const step = async (strength: 'security' | 'password' = 'security') => {
    const response = await request('/api/v1/auth/step-up', {
      password: PASSWORD,
      strength,
      ...(strength === 'security' ? { totpCode: totp(enrolled.secret, clock.now) } : {}),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    auth.cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? '';
    auth.csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
  };
  return { server, logs, clock, auth, request, step };
}
describe('encrypted export HTTP boundary', () => {
  it('releases upload reservations after export schema failures and import authentication failures', async () => {
    const h = await harness();
    await h.step();
    const invalid = await h.request('/api/v1/export', {
      ...BODY,
      passphraseConfirmation: 'a different long passphrase',
    });
    expect(invalid.status).toBe(400);
    const output = await h.request('/api/v1/export', BODY);
    expect(output.status).toBe(200);
    const envelope: unknown = await output.json();
    const wrongPassphrase = await h.request('/api/v1/export/import', {
      passphrase: 'a wrong but long passphrase',
      envelope,
    });
    expect(wrongPassphrase.status).toBe(400);
    const failure = await wrongPassphrase.text();
    expect(failure).not.toContain('a wrong but long passphrase');
    expect(failure).not.toContain('ciphertext');
    expect((await h.request('/api/v1/export/import', { passphrase: PASS, envelope })).status).toBe(200);
  });

  it('leaves unrelated methods and paths to the normal router', async () => {
    const h = await harness();
    const response = await h.server.app.request('/api/v1/export', { method: 'GET', headers: { host: 'localhost' } });
    expect(response.status).toBe(404);
    expect((await h.request('/api/v1/export/unrecognised', BODY)).status).toBe(404);
  });

  it('requires authenticated manage access, same origin, CSRF and security strength', async () => {
    const h = await harness();
    for (const path of ['/api/v1/export', '/api/v1/export/import']) {
      expect((await h.request(path, BODY, { cookie: '' })).status).toBe(401);
      expect((await h.request(path, BODY, { origin: 'https://evil.invalid' })).status).toBe(403);
      expect((await h.request(path, BODY, { 'x-csrf-token': '' })).status).toBe(403);
      expect((await h.request(path, BODY)).status).toBe(403);
    }
    await h.step('password');
    expect((await h.request('/api/v1/export', BODY)).status).toBe(403);
    h.clock.now = new Date(h.clock.now.getTime() + 30000);
    await h.step();
    const response = await h.request('/api/v1/export', BODY);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="lightning-pilot-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const envelope: unknown = await response.json();
    const destination = await harness();
    await destination.step();
    const imported = await destination.request('/api/v1/export/import', { passphrase: PASS, envelope });
    expect(imported.status, await imported.clone().text()).toBe(200);
    expect(await imported.json()).toMatchObject({ nodes: 0, intents: 0 });
    expect(h.logs.join('\n')).not.toContain(PASS);
  });
  it('returns generic errors without malformed input, unknown fields or crypto details', async () => {
    const h = await harness();
    await h.step();
    const canary = 'ATTACKER_CONTROLLED_SECRET_CANARY';
    for (const body of [
      `{"${canary}":`,
      JSON.stringify({ passphrase: PASS, [canary]: canary }),
      JSON.stringify({ passphrase: PASS, envelope: { format: canary } }),
    ]) {
      const response = await h.request('/api/v1/export/import', body, {}, true);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(canary);
    }
    expect(h.logs.join('\n')).not.toContain(canary);
    expect(h.logs.join('\n')).not.toContain(PASS);
  });
  it('limits enlarged bodies to import and reserves the operation before buffering', async () => {
    const h = await harness();
    await h.step();
    const large = JSON.stringify({ passphrase: 'x'.repeat(70000) });
    const ordinary = await h.request('/api/v1/export', large, {}, true);
    expect(ordinary.status).toBe(400);
    expect(await ordinary.json()).toMatchObject({ error: { code: 'body_too_large' } });
    // Import exceeds the ordinary cap but remains bounded; it reaches schema validation instead of 413.
    const acceptedSize = await h.request('/api/v1/export/import', large, {}, true);
    expect(acceptedSize.status).toBe(400);
    expect(await acceptedSize.json()).toMatchObject({ error: { code: 'validation_failed' } });
    const oversized = await h.request('/api/v1/export/import', ' '.repeat(EXPORT_REQUEST_BYTES + 1), {}, true);
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: { code: 'body_too_large' } });
    const understated = await h.request(
      '/api/v1/export/import',
      ' '.repeat(EXPORT_REQUEST_BYTES + 1),
      { 'content-length': '1' },
      true,
    );
    expect(await understated.json()).toMatchObject({ error: { code: 'body_too_large' } });
    const exaggerated = await h.request(
      '/api/v1/export/import',
      '{}',
      { 'content-length': String(EXPORT_REQUEST_BYTES + 1) },
      true,
    );
    expect(await exaggerated.json()).toMatchObject({ error: { code: 'body_too_large' } });
    let release = () => {};
    const held = h.server.exports.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      const response = await h.request('/api/v1/export/import', ' '.repeat(EXPORT_REQUEST_BYTES + 1), {}, true);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
    } finally {
      release();
      await held;
    }
    expect((await h.request('/api/v1/export', BODY)).status).toBe(200);
  });
  it('rejects an expired security grant before malformed upload parsing', async () => {
    const h = await harness();
    await h.step();
    h.clock.now = new Date(h.clock.now.getTime() + 300000);
    expect((await h.request('/api/v1/export/import', '{malformed', {}, true)).status).toBe(403);
  });
});
