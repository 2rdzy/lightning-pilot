// Configuration: a JSON file validated by a strict schema, then environment variables, then command-line flags
// (defaults < file < environment < flags). Every key has a default; unknown keys are refused with their full path so
// typos fail loudly. No secret ever lives in configuration: the vault key comes from its own file, node credentials
// from the vault, passwords from setup. This is the minimal subset of keys the walking skeleton needs.
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { z } from 'zod';

export class ConfigError extends Error {}

const level = z.enum(['error', 'warn', 'info', 'debug']);

const Schema = z.strictObject({
  version: z.literal(1).default(1),
  server: z
    .strictObject({
      listen: z
        .string()
        .refine((a) => isIP(a) !== 0, 'an IP address')
        .default('127.0.0.1'),
      port: z.int().min(1).max(65535).default(8443),
      hosts: z.array(z.string().min(1).max(253)).min(1).default(['localhost', '127.0.0.1', '::1']),
      // isIP accepts IPv6 zone IDs (fe80::1%eth0), which login source matching never trusts: refuse them here.
      trustedProxies: z
        .array(z.string().refine((a) => isIP(a) !== 0 && !a.includes('%'), 'an IP address without a zone ID'))
        .default([]),
    })
    .prefault({}),
  tls: z
    .strictObject({
      mode: z.enum(['self-signed', 'files', 'off']).default('self-signed'),
      certFile: z.string().optional(),
      keyFile: z.string().optional(),
    })
    .prefault({}),
  paths: z
    .strictObject({
      dataDir: z.string().default('/var/lib/lightning-pilot'),
      vaultKey: z.string().optional(),
    })
    .prefault({}),
  log: z
    .strictObject({
      level: level.default('info'),
      modules: z.record(z.string(), level).default({}),
    })
    .prefault({}),
  limits: z.strictObject({ maxNodes: z.int().min(1).max(100).default(10) }).prefault({}),
});

export type Config = z.infer<typeof Schema>;

export interface LoadedConfig {
  config: Config;
  // Absolute path of the vault key file (configured, or $CREDENTIALS_DIRECTORY/vault-key from systemd).
  vaultKeyPath: string;
  // --dev: development mode, the only mode in which regtest nodes may be added.
  dev: boolean;
}

// Key names refused anywhere in the file, to stop a mistaken "helpful" edit from putting a secret here.
const FORBIDDEN = new Set(['password', 'secret', 'token', 'rune', 'macaroon', 'key']);

function findForbidden(value: unknown, path: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const [k, v] of Object.entries(value)) {
    const here = path ? `${path}.${k}` : k;
    if (FORBIDDEN.has(k.toLowerCase())) return here;
    const nested = findForbidden(v, here);
    if (nested) return nested;
  }
  return undefined;
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);

// LP_<SECTION>_<KEY> for the scalar and list keys of the schema; lists as JSON.
const ENV_KEYS: Record<string, [string, string]> = {};
for (const [section, shape] of Object.entries(Schema.shape)) {
  const inner = (shape as unknown as { unwrap?: () => { shape?: Record<string, unknown> } }).unwrap?.().shape;
  if (!inner) continue;
  for (const key of Object.keys(inner)) {
    if (section === 'log' && key === 'modules') continue;
    ENV_KEYS[`LP_${section.toUpperCase()}_${key.toUpperCase()}`] = [section, key];
  }
}

function envValue(raw: string): unknown {
  if (/^-?[0-9]+$/.test(raw)) return Number(raw);
  if (raw.startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ConfigError('environment list values must be JSON arrays');
    }
  }
  return raw;
}

function parseArgs(argv: readonly string[]): { configPath?: string; dev: boolean } {
  let configPath: string | undefined;
  let dev = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      configPath = argv[++i];
      if (!configPath) throw new ConfigError('--config needs a path');
    } else if (arg === '--dev') {
      dev = true;
    } else {
      throw new ConfigError(`unknown argument ${arg ?? ''}`);
    }
  }
  return { ...(configPath === undefined ? {} : { configPath }), dev };
}

const DEFAULT_PATH = '/etc/lightning-pilot/config.json';

export function loadConfig(options: {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}): LoadedConfig {
  const env = options.env ?? {};
  const args = parseArgs(options.argv ?? []);
  const path = args.configPath ?? env.LP_CONFIG ?? DEFAULT_PATH;
  const explicit = args.configPath !== undefined || env.LP_CONFIG !== undefined;

  let fileValue: unknown = {};
  let text: string | undefined;
  try {
    text = (options.readFile ?? ((p) => readFileSync(p, 'utf8')))(path);
  } catch (err) {
    // A missing file at the default location means "all defaults"; a file named explicitly must exist.
    if (explicit || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(`cannot read configuration file ${path}`);
    }
  }
  if (text !== undefined) {
    try {
      fileValue = JSON.parse(text);
    } catch {
      throw new ConfigError(`${path} is not valid JSON`);
    }
  }
  if (fileValue === null || typeof fileValue !== 'object' || Array.isArray(fileValue)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }
  const forbidden = findForbidden(fileValue, '');
  if (forbidden) throw new ConfigError(`${forbidden} is not allowed: configuration never holds secrets`);
  const version = (fileValue as { version?: unknown }).version;
  if (typeof version === 'number' && version > 1) {
    throw new ConfigError(`configuration version ${version} is newer than this release understands`);
  }

  const merged = structuredClone(fileValue) as Record<string, Record<string, unknown>>;
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith('LP_') || name === 'LP_CONFIG' || raw === undefined) continue;
    const target = ENV_KEYS[name];
    if (!target) throw new ConfigError(`environment variable ${name} is not a known setting`);
    const [section, key] = target;
    merged[section] = { ...(merged[section] ?? {}), [key]: envValue(raw) };
  }

  const result = Schema.safeParse(merged);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    if (issue?.code === 'unrecognized_keys') {
      const key = [where, issue.keys[0]].filter(Boolean).join('.');
      throw new ConfigError(`${key} is not a known key`);
    }
    throw new ConfigError(`${where || 'configuration'}: ${issue?.message ?? 'invalid'}`);
  }
  const config = result.data;

  if (config.tls.mode === 'self-signed') {
    // A certificate cannot be generated with Node's built-in crypto alone; until that lands, say what to do.
    throw new ConfigError(
      'tls.mode "self-signed" is not available yet: use "files" with your own certificate, or "off" behind a local TLS proxy',
    );
  }
  if (config.tls.mode === 'files' && (!config.tls.certFile || !config.tls.keyFile)) {
    throw new ConfigError('tls.mode "files" needs tls.certFile and tls.keyFile');
  }
  if (config.tls.mode === 'off' && !LOOPBACK.has(config.server.listen)) {
    throw new ConfigError('tls.mode "off" is only allowed when server.listen is a loopback address');
  }

  const credentialsDir = env.CREDENTIALS_DIRECTORY;
  const vaultKeyPath = config.paths.vaultKey ?? (credentialsDir ? `${credentialsDir}/vault-key` : '');
  if (vaultKeyPath === '') throw new ConfigError('vault key not provided: set paths.vaultKey or start under systemd');
  return { config, vaultKeyPath, dev: args.dev };
}
