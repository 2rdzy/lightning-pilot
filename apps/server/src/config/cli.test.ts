import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const main = fileURLToPath(new URL('../main.ts', import.meta.url));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('LP_') && key !== 'CREDENTIALS_DIRECTORY' && key !== 'NODE_OPTIONS',
  ),
);
function fixture(config: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'lp-cli-'));
  directories.push(directory);
  const dataDir = join(directory, 'uncreated-data');
  const logDir = join(directory, 'uncreated-logs');
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({ paths: { dataDir, logDir }, ...config }));
  return { directory, dataDir, logDir, path };
}
const run = (...args: string[]) =>
  spawnSync(process.execPath, [main, ...args], {
    encoding: 'utf8',
    env,
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
describe('configuration check executable', () => {
  it('accepts the shipped example in development mode without needing a vault or TLS key', () => {
    const result = run(
      'config',
      'check',
      '--config',
      fileURLToPath(new URL('./config.example.json', import.meta.url)),
      '--dev',
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('configuration valid\n');
  }, 20000);
  it('validates self-signed configuration without creating data, logs, lock or certificate resources', () => {
    const f = fixture({ tls: { mode: 'self-signed' } });
    const result = run('config', 'check', '--config', f.path, '--dev');
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('configuration valid\n');
    expect(existsSync(f.dataDir)).toBe(false);
    expect(existsSync(f.logDir)).toBe(false);
    expect(readdirSync(f.directory)).toEqual(['config.json']);
  }, 20000);
  it.each([
    { config: { server: { port: 0 } }, args: [], error: 'server.port' },
    { config: {}, args: ['--unknown'], error: 'unknown argument --unknown' },
    { config: { password: 'never-print-this-secret' }, args: [], error: 'password is not allowed' },
    { config: { version: 2 }, args: [], error: 'newer than this release' },
  ])(
    'returns nonzero without creating state for $error',
    ({ config, args, error }) => {
      const f = fixture(config);
      const result = run('config', 'check', '--config', f.path, '--dev', ...args);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('never-print-this-secret');
      expect(existsSync(f.dataDir)).toBe(false);
      expect(existsSync(f.logDir)).toBe(false);
      expect(readdirSync(f.directory)).toEqual(['config.json']);
    },
    20000,
  );
});
