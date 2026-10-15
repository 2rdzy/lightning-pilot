import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProtectedFile, isReadOnlyMount } from './ownership.ts';
import { parseCommand } from './cli.ts';
import { assertDiagnostics, ConfigError, loadConfig } from './config.ts';

const base = { tls: { mode: 'off' }, paths: { vaultKey: '/run/key' } };
const load = (file: unknown, extra: { argv?: string[]; env?: Record<string, string> } = {}) =>
  loadConfig({ readFile: () => JSON.stringify(file), ...extra });

describe('configuration', () => {
  it('fills every key with its default', () => {
    const { config, dev } = load(base);
    expect(config.server).toEqual({
      listen: '127.0.0.1',
      port: 8443,
      hosts: ['localhost', '127.0.0.1', '::1'],
      trustedProxies: [],
    });
    expect(config.log).toEqual({
      level: 'info',
      destination: 'files',
      retentionDays: 365,
      maxTotalMB: 1024,
      modules: {},
    });
    expect(config.paths.logDir).toBe('/var/log/lightning-pilot');
    expect(config.outbound).toEqual({ timeoutMs: 10000, maxResponseBytes: 1048576 });
    expect(config.limits).toEqual({ maxNodes: 10 });
    expect(config.tor).toEqual({});
    expect(dev).toBe(false);
  });

  it('refuses an IPv6 zone ID as a trusted proxy, which login source matching would never trust', () => {
    expect(
      load({ ...base, server: { trustedProxies: ['fe80::1', '192.0.2.1'] } }).config.server.trustedProxies,
    ).toEqual(['fe80::1', '192.0.2.1']);
    expect(() => load({ ...base, server: { trustedProxies: ['fe80::1%eth0'] } })).toThrow(/trustedProxies/);
  });

  it('refuses unknown keys with their full path', () => {
    expect(() => load({ ...base, server: { prot: 1 } })).toThrow('server.prot is not a known key');
    expect(() => load({ ...base, extra: true })).toThrow('extra is not a known key');
  });

  it('refuses keys that look like secrets, anywhere', () => {
    expect(() => load({ ...base, server: { password: 'x' } })).toThrow('server.password is not allowed');
    expect(() => load({ ...base, rune: 'x' })).toThrow('rune is not allowed');
  });

  it('refuses a newer configuration version and invalid values', () => {
    expect(() => load({ ...base, version: 2 })).toThrow('newer than this release');
    expect(() => load({ ...base, server: { port: 0 } })).toThrow(ConfigError);
    expect(() => load({ ...base, server: { listen: 'everywhere' } })).toThrow(ConfigError);
  });

  it('applies environment variables over the file, and flags over both', () => {
    const { config, dev } = load(base, {
      env: { LP_SERVER_PORT: '9000', LP_SERVER_HOSTS: '["node.lan"]', LP_LOG_LEVEL: 'debug' },
      argv: ['--dev'],
    });
    expect(config.server.port).toBe(9000);
    expect(config.server.hosts).toEqual(['node.lan']);
    expect(config.log.level).toBe('debug');
    expect(dev).toBe(true);
  });

  it('refuses unknown LP_ variables and unknown arguments', () => {
    expect(() => load(base, { env: { LP_VAULT_KEY: 'x' } })).toThrow('LP_VAULT_KEY is not a known setting');
    expect(() => load(base, { argv: ['--debug'] })).toThrow('unknown argument --debug');
  });

  it('uses defaults when the default file is missing, but requires a named file', () => {
    const missing = () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    const env = { LP_TLS_MODE: 'off', CREDENTIALS_DIRECTORY: '/run/credentials/lp' };
    expect(loadConfig({ readFile: missing, env }).vaultKeyPath).toBe('/run/credentials/lp/vault-key');
    expect(() => loadConfig({ readFile: missing, argv: ['--config', '/x.json'], env })).toThrow('cannot read');
  });

  it('refuses TLS settings it cannot honour', () => {
    expect(load({ paths: { vaultKey: '/k' } }).config.tls.mode).toBe('self-signed');
    expect(() => load({ ...base, tls: { mode: 'files' } })).toThrow('needs tls.certFile');
    expect(() => load({ ...base, server: { listen: '0.0.0.0' } })).toThrow('loopback');
  });

  it('needs a vault key path', () => {
    expect(() => load({ tls: { mode: 'off' } })).toThrow('vault key not provided');
  });
});

describe('complete configuration contract', () => {
  it('reports secret keys nested in arrays with their complete path', () => {
    expect(() => load({ ...base, server: { hosts: [{ token: 'secret' }] } })).toThrow(
      'server.hosts.0.token is not allowed',
    );
    expect(() => load({ ...base, extra: [{ nested: { MACAROON: 'secret' } }] })).toThrow(
      'extra.0.nested.MACAROON is not allowed',
    );
  });
  it('applies new environment keys and chooses explicit argv config over LP_CONFIG', () => {
    const paths: string[] = [];
    const result = loadConfig({
      readFile: (path) => {
        paths.push(path);
        return JSON.stringify({ ...base, log: { maxTotalMB: 8 } });
      },
      argv: ['--config', '/explicit.json'],
      env: {
        LP_CONFIG: '/environment.json',
        LP_LOG_DESTINATION: 'both',
        LP_LOG_RETENTIONDAYS: '7',
        LP_LOG_MAXTOTALMB: '12',
        LP_PATHS_LOGDIR: '/logs',
        LP_OUTBOUND_TIMEOUTMS: '2500',
        LP_OUTBOUND_MAXRESPONSEBYTES: '4096',
        LP_LIMITS_MAXNODES: '3',
      },
    });
    expect(paths).toEqual(['/explicit.json']);
    expect(result.config.log).toMatchObject({ destination: 'both', retentionDays: 7, maxTotalMB: 12 });
    expect(result.config.paths.logDir).toBe('/logs');
    expect(result.config.outbound).toEqual({ timeoutMs: 2500, maxResponseBytes: 4096 });
    expect(result.config.limits.maxNodes).toBe(3);
  });
  it.each([
    { log: { retentionDays: 0 } },
    { log: { retentionDays: 366 } },
    { log: { maxTotalMB: 0 } },
    { log: { maxTotalMB: 1048577 } },
    { outbound: { timeoutMs: 0 } },
    { outbound: { timeoutMs: 300001 } },
    { outbound: { maxResponseBytes: 0 } },
    { outbound: { maxResponseBytes: 1073741825 } },
    { limits: { maxNodes: 0 } },
    { limits: { maxNodes: 101 } },
    { server: { port: 65536 } },
    { server: { torPort: 0 } },
  ])('rejects out of bounds values: %j', (fields) => {
    expect(() => load({ ...base, ...fields })).toThrow(ConfigError);
  });
  it('accepts numeric upper bounds', () => {
    const { config } = load({
      ...base,
      log: { retentionDays: 365, maxTotalMB: 1048576 },
      outbound: { timeoutMs: 300000, maxResponseBytes: 1073741824 },
      limits: { maxNodes: 100 },
    });
    expect(config.limits.maxNodes).toBe(100);
  });
  it('config check does not require a vault key or open one', () => {
    expect(loadConfig({ readFile: () => '{}', checkOnly: true }).vaultKeyPath).toBe('');
    expect(parseCommand(['config', 'check', '--config', '/test.json'])).toEqual({
      command: 'config-check',
      args: ['--config', '/test.json'],
      newKeyFile: undefined,
    });
  });
});
describe('production diagnostics policy', () => {
  it.each([
    '--inspect',
    '--inspect=127.0.0.1:9229',
    '--inspect-brk',
    '--inspect-wait=9229',
    '--inspect-port=9229',
    '--heapsnapshot-signal=SIGUSR2',
    '--heapsnapshot-near-heap-limit=1',
    '--report-on-signal',
    '--report-on-fatalerror',
    '--report-directory=/tmp',
    '--diagnostic-dir=/tmp',
  ])('refuses %s from environment and actual Node args', (flag) => {
    expect(() => assertDiagnostics(flag, [])).toThrow('diagnostic');
    expect(() => assertDiagnostics('', [flag])).toThrow('diagnostic');
    expect(() => load(base, { env: { NODE_OPTIONS: flag } })).toThrow('diagnostic');
  });
  it('permits ordinary Node options and development diagnostics', () => {
    expect(() => assertDiagnostics('--max-old-space-size=512 --enable-source-maps', [])).not.toThrow();
    expect(load(base, { argv: ['--dev'], env: { NODE_OPTIONS: '--inspect' } }).dev).toBe(true);
  });
});
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe('protected operator files', () => {
  it('uses the longest mount prefix and decodes escaped paths', () => {
    const mountinfo = [
      '1 0 0:1 / / rw - ext4 /dev/root rw',
      '2 1 0:2 / /run/secrets ro - tmpfs tmpfs ro',
      '3 2 0:3 / /run/secrets/writable rw - tmpfs tmpfs rw',
      '4 1 0:4 / /space\\040name ro - tmpfs tmpfs ro',
    ].join('\n');
    expect(isReadOnlyMount('/run/secrets/key', mountinfo)).toBe(true);
    expect(isReadOnlyMount('/run/secrets/writable/key', mountinfo)).toBe(false);
    expect(isReadOnlyMount('/run/secrets-other/key', mountinfo)).toBe(false);
    expect(isReadOnlyMount('/space name/key', mountinfo)).toBe(true);
  });
  it('refuses writable and symlinked real files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lp-config-'));
    temporaryDirectories.push(dir);
    const file = join(dir, 'config.json');
    writeFileSync(file, '{}', { mode: 0o666 });
    chmodSync(file, 0o666);
    expect(() => assertProtectedFile(file, process.getuid?.(), false)).toThrow('unsafe file');
    chmodSync(file, 0o600);
    const link = join(dir, 'link');
    symlinkSync(file, link);
    expect(() => assertProtectedFile(link, process.getuid?.(), false)).toThrow('regular file');
    expect(loadConfig({ argv: ['--dev', '--config', file], env: {}, checkOnly: true }).dev).toBe(true);
  });
  it.skipIf(process.getuid?.() === 0)('refuses real files with a different owner expectation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lp-owner-'));
    temporaryDirectories.push(dir);
    const file = join(dir, 'key');
    writeFileSync(file, 'key', { mode: 0o600 });
    expect(() => assertProtectedFile(file, (process.getuid?.() ?? 1000) + 1, false)).toThrow(/owner/);
  });
});
