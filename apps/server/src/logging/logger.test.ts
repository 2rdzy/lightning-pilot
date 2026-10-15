import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePaymentHash, parsePubkey, parseTxid, type Txid } from '@lightning-pilot/core';
import { createLogger } from './logger.ts';
import { nodeDetail, REDACTED, redactString } from './redact.ts';

function capture(level: 'info' | 'debug' = 'info') {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ level, sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }, 'test');
  return { lines, logger };
}

const hex64 = 'ab'.repeat(32);
const rune = 'u3ho3QUnwNbrwyn6pITK4bv2Q3W-V9JeAaTV9rMDTj09MCZpZCEmbWV0aG9kPWdldGluZm8';

describe('logger', () => {
  it('writes one JSON object per line with time, level, module, msg and requestId', () => {
    const { lines, logger } = capture();
    logger.info('node added', { requestId: 'r-1', chain: 'blake2b' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      module: 'test',
      msg: 'node added',
      requestId: 'r-1',
      chain: 'blake2b',
    });
    expect(Date.parse(String(lines[0]?.time))).not.toBeNaN();
  });

  it('drops lines below the level, per module', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', modules: { chatty: 'debug' }, sink: (l) => lines.push(l) });
    logger.info('hidden');
    logger.child('chatty').debug('shown');
    expect(lines).toHaveLength(1);
  });

  it('redacts denied field names at any depth', () => {
    const { lines, logger } = capture();
    logger.info('x', {
      password: 'hunter2',
      nested: { viewRune: 'abc', sessionToken: 't', deep: [{ preimage: 'p', Authorization: 'a', cookie: 'c' }] },
      keyId: '0123456789abcdef',
      idempotencyKey: 'k',
    });
    const line = JSON.stringify(lines[0]);
    for (const secret of ['hunter2', '"abc"', '"t"', '"p"', '"a"', '"c"', '"k"']) expect(line).not.toContain(secret);
    expect(lines[0]?.keyId).toBe('0123456789abcdef');
  });

  it('keeps typed identifiers only when they have their shape', () => {
    const { lines, logger } = capture();
    logger.info('x', {
      paymentHash: parsePaymentHash(hex64),
      pubkey: parsePubkey('02' + hex64),
      txid: parseTxid(hex64),
    });
    logger.info('y', { txid: 'not-a-txid' as Txid, pubkey: hex64 as never });
    expect(lines[0]).toMatchObject({ paymentHash: hex64, txid: hex64, pubkey: '02' + hex64 });
    expect(lines[1]).toMatchObject({ txid: REDACTED, pubkey: REDACTED });
  });

  it('scans string values for secret shapes in any other field', () => {
    const samples = [
      `rune ${rune} here`,
      `preimage ${hex64}`,
      'pay lnbcrt10n1p4v6pa9sp5m08939vx3laehags3dtga80af34n7f6ugke06lqj5xrvy7vugmzqpp5x',
      'Bearer abc.def',
      'tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK',
      'cHNidP8BAHECAAAAAQ',
      'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
      '123456789:AAEhBP0av28gSJ7C1UvWcSyfXKkDsZM_xyz',
    ];
    for (const sample of samples) expect(redactString(sample), sample).toContain(REDACTED);
    const { lines, logger } = capture();
    logger.info('x', { note: `with ${rune}`, err: new Error(`failed for ${hex64}`) });
    expect(JSON.stringify(lines[0])).not.toContain(rune);
    expect(JSON.stringify(lines[0])).not.toContain(hex64);
  });

  it('cuts node error text to 500 characters after redaction', () => {
    expect(nodeDetail('no route. '.repeat(200))?.length).toBe(500);
    expect(nodeDetail(`bad ${hex64}`)).toBe(`bad ${REDACTED}`);
  });

  it('prints the setup token on its own line to stdout only', () => {
    const lines: string[] = [];
    const out: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), stdout: (l) => out.push(l) });
    logger.setupToken('ABCD-EFGH', 'https://localhost:8443/setup');
    expect(lines).toEqual([]);
    expect(JSON.parse(out[0] ?? '{}')).toMatchObject({
      setupToken: 'ABCD-EFGH',
      setupUrl: 'https://localhost:8443/setup',
    });
  });
});

const logDirectories: string[] = [];
afterEach(() => {
  for (const path of logDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const logDirectory = () => {
  const path = mkdtempSync(join(tmpdir(), 'lp-logger-'));
  logDirectories.push(path);
  return path;
};
describe('logger hardened destinations', () => {
  it('protects the fixed envelope and scans request IDs and nested untyped identifiers', () => {
    const output: string[] = [];
    const logger = createLogger(
      { now: () => new Date('2026-10-15T00:00:00Z'), sink: (line) => output.push(line) },
      'safe-module',
    );
    logger.info('safe message', {
      time: 'forged',
      level: 'forged',
      module: 'forged',
      msg: 'forged',
      requestId: `request-${hex64}`,
      nested: { txid: hex64, paymentHash: hex64 },
    });
    expect(JSON.parse(output[0] ?? '{}')).toEqual({
      time: '2026-10-15T00:00:00.000Z',
      level: 'info',
      module: 'safe-module',
      msg: 'safe message',
      requestId: `request-${REDACTED}`,
      nested: { txid: REDACTED, paymentHash: REDACTED },
    });
  });
  it('contains failing injected sinks and shares one fallback warning with children', () => {
    const output: string[] = [];
    const logger = createLogger({
      sink: () => {
        throw new Error('broken sink');
      },
      stdout: (line) => output.push(line),
    });
    expect(() => logger.info('parent')).not.toThrow();
    expect(() => logger.child('child').warn('child')).not.toThrow();
    expect(output.map((line) => JSON.parse(line) as { msg: string }).map((entry) => entry.msg)).toEqual([
      'log sink unavailable',
      'parent',
      'child',
    ]);
  });
  it('shares file fallback cooldown and recovery across all child loggers', () => {
    const root = logDirectory();
    const directory = join(root, 'blocked');
    writeFileSync(directory, 'blocked');
    const output: string[] = [];
    let time = new Date('2026-10-15T00:00:00Z');
    const logger = createLogger({
      destination: 'files',
      directory,
      stdout: (line) => output.push(line),
      now: () => time,
    });
    const child = logger.child('child');
    logger.info('parent');
    child.info('child');
    expect(output.filter((line) => line.includes('file logging unavailable'))).toHaveLength(1);
    rmSync(directory);
    child.info('still waiting');
    expect(output.map((line) => JSON.parse(line) as { msg: string }).at(-1)?.msg).toBe('still waiting');
    time = new Date('2026-10-15T00:10:00Z');
    child.info('recovered');
    logger.info('parent recovered');
    const lines = readFileSync(join(directory, '2026/10/20261015.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { module: string; msg: string });
    expect(lines).toMatchObject([
      { module: 'child', msg: 'recovered' },
      { module: 'server', msg: 'parent recovered' },
    ]);
  });
  it('excludes secret canaries in plaintext, hex and base64 from both destinations', () => {
    const directory = logDirectory();
    const output: string[] = [];
    const logger = createLogger({
      destination: 'both',
      directory,
      stdout: (line) => output.push(line),
      now: () => new Date('2026-10-15T00:00:00Z'),
    });
    const fields = [
      'password',
      'passwordHash',
      'totpCode',
      'totpSecret',
      'rune',
      'macaroon',
      'preimage',
      'sessionCookie',
      'sessionId',
      'confirmationToken',
      'confirmationId',
      'apiToken',
      'nostrPrivateKey',
      'telegramBotToken',
    ];
    const secrets: string[] = [];
    for (const [index, field] of fields.entries()) {
      const plain = field === 'totpCode' ? '294763' : `canary-value-${index}-sensitive`;
      const values = [plain, Buffer.from(plain).toString('hex'), Buffer.from(plain).toString('base64')];
      secrets.push(...values);
      for (const value of values)
        logger.child('credentials').info('operation rejected', { nested: [{ [field]: value }] });
    }
    const hex = Buffer.alloc(32, 0x79).toString('hex');
    const base64 = Buffer.alloc(48, 0x6b).toString('base64');
    secrets.push(hex, base64);
    logger.info('remote operation failed', { detail: `secret shaped ${hex} ${base64}`, requestId: base64 });
    const file = readFileSync(join(directory, '2026/10/20261015.jsonl'), 'utf8');
    const stdout = output.join('\n') + '\n';
    expect(file).toBe(stdout);
    for (const secret of secrets) {
      expect(file).not.toContain(secret);
      expect(stdout).not.toContain(secret);
    }
    expect(output).toHaveLength(fields.length * 3 + 1);
  });
  it('redacts binary credentials and keeps the deliberate audit session handle', () => {
    const { lines, logger } = capture();
    logger.info('operation rejected', {
      bytes: Buffer.from('binary-secret'),
      nested: { bytes: new Uint8Array([11, 22, 33]) },
      sessionHandle: 'audit-handle',
    });
    expect(lines[0]).toMatchObject({ bytes: REDACTED, nested: { bytes: REDACTED }, sessionHandle: 'audit-handle' });
  });
  it('never writes the one-time setup token to the file destination', () => {
    const directory = logDirectory();
    const output: string[] = [];
    const logger = createLogger({
      destination: 'both',
      directory,
      stdout: (line) => output.push(line),
      now: () => new Date('2026-10-15T00:00:00Z'),
    });
    logger.info('starting');
    logger.setupToken('setup-only-canary', 'https://localhost:8443/setup');
    logger.info('ready');
    expect(output.filter((line) => line.includes('setup-only-canary'))).toHaveLength(1);
    expect(readFileSync(join(directory, '2026/10/20261015.jsonl'), 'utf8')).not.toContain('setup-only-canary');
  });
});
