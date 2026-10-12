import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

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
    expect(config.log.level).toBe('info');
    expect(dev).toBe(false);
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
    expect(() => load({ paths: { vaultKey: '/k' } })).toThrow('self-signed');
    expect(() => load({ ...base, tls: { mode: 'files' } })).toThrow('needs tls.certFile');
    expect(() => load({ ...base, server: { listen: '0.0.0.0' } })).toThrow('loopback');
  });

  it('needs a vault key path', () => {
    expect(() => load({ tls: { mode: 'off' } })).toThrow('vault key not provided');
  });
});
