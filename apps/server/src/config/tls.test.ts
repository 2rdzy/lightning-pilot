import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from './config.ts';
import { inspectTls, tlsPaths } from './tls.ts';
import { createLogger } from '../logging/logger.ts';
let root: string;
let certFile: string;
let keyFile: string;
let otherKey: string;
let certificate: X509Certificate;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-tls-'));
  mkdirSync(join(root, 'tls'));
  certFile = join(root, 'tls/cert.pem');
  keyFile = join(root, 'tls/key.pem');
  otherKey = join(root, 'other.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '365',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'pipe' },
  );
  execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', otherKey], {
    stdio: 'pipe',
  });
  certificate = new X509Certificate(readFileSync(certFile));
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function config(tls: Partial<Config['tls']> = {}): Config {
  return loadConfig({ readFile: () => JSON.stringify({ paths: { dataDir: root, vaultKey: '/unused' }, tls }) }).config;
}
function logger() {
  const entries: { level: string; msg: string }[] = [];
  return {
    entries,
    log: createLogger({ sink: (line) => entries.push(JSON.parse(line) as { level: string; msg: string }) }),
  };
}
const validNow = () => new Date(Date.parse(certificate.validFrom) + 60_000);
describe('TLS operator certificate inspection', () => {
  it('resolves self-signed paths and reports actual fingerprint and expiry', () => {
    const c = config();
    const l = logger();
    expect(tlsPaths(c)).toEqual({ certFile, keyFile });
    expect(inspectTls(c, l.log, true, validNow())).toEqual({
      fingerprintSha256: certificate.fingerprint256,
      expiresAt: new Date(certificate.validTo).toISOString(),
    });
    expect(l.entries.map((entry) => entry.level)).toEqual(['info']);
  });
  it('warns when certificate expiry is within thirty days', () => {
    const l = logger();
    inspectTls(config(), l.log, true, new Date(Date.parse(certificate.validTo) - 86400000));
    expect(l.entries).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'TLS certificate expires soon' }));
  });
  it('rejects expired and not-yet-valid certificates at exact validity boundaries', () => {
    const l = logger();
    expect(() => inspectTls(config(), l.log, true, new Date(certificate.validTo))).toThrow('invalid or mismatched');
    expect(() => inspectTls(config(), l.log, true, new Date(Date.parse(certificate.validFrom) - 1))).toThrow(
      'invalid or mismatched',
    );
    expect(inspectTls(config(), l.log, true, new Date(certificate.validFrom))).toBeDefined();
  });
  it('uses configured files and rejects mismatched private keys', () => {
    const c = config({ mode: 'files', certFile, keyFile });
    expect(tlsPaths(c)).toEqual({ certFile, keyFile });
    expect(inspectTls(c, logger().log, true, validNow())?.fingerprintSha256).toBe(certificate.fingerprint256);
    expect(() =>
      inspectTls(config({ mode: 'files', certFile, keyFile: otherKey }), logger().log, true, validNow()),
    ).toThrow('invalid or mismatched');
  });
  it('refuses missing or malformed certificates and private keys', () => {
    const invalid = join(root, 'invalid.pem');
    writeFileSync(invalid, 'invalid certificate');
    for (const tls of [
      { mode: 'files' as const, certFile: join(root, 'missing.pem'), keyFile },
      { mode: 'files' as const, certFile: invalid, keyFile },
      { mode: 'files' as const, certFile, keyFile: invalid },
      { mode: 'files' as const, certFile, keyFile: join(root, 'missing-key.pem') },
    ])
      expect(() => inspectTls(config(tls), logger().log, true, validNow())).toThrow(
        'missing, unsafe, invalid or mismatched',
      );
  });
  it('refuses writable or symlinked production private keys', () => {
    const writable = join(root, 'writable-key.pem');
    copyFileSync(keyFile, writable);
    chmodSync(writable, 0o666);
    const link = join(root, 'linked-key.pem');
    symlinkSync(keyFile, link);
    for (const path of [writable, link])
      expect(() =>
        inspectTls(config({ mode: 'files', certFile, keyFile: path }), logger().log, false, validNow()),
      ).toThrow('unsafe');
  });
  it('does not read TLS files when TLS is disabled', () => {
    const l = logger();
    expect(
      inspectTls(config({ mode: 'off', certFile: '/does/not/exist', keyFile: '/does/not/exist' }), l.log),
    ).toBeUndefined();
    expect(l.entries).toEqual([]);
  });
  it('refuses unsupported Tor settings even when TLS is off', () => {
    const c = config({ mode: 'off' });
    expect(() => inspectTls({ ...c, server: { ...c.server, torPort: 8444 } }, logger().log, true)).toThrow(
      'Tor listener is not supported',
    );
    expect(() => inspectTls({ ...c, tor: { hostnameFile: '/tor/hostname' } }, logger().log, true)).toThrow(
      'Tor listener is not supported',
    );
  });
});
