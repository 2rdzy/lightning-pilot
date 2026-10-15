import { describe, expect, it } from 'vitest';
import {
  ExportEnvelope,
  ExportNode,
  ExportPassphrase,
  ExportPayload,
  ExportRequest,
  ImportRequest,
  ImportResponse,
} from './export.ts';

const time = '2026-10-15T12:00:00.000Z';
const node = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Portable node',
  chain: 'bitcoin',
  network: 'regtest',
  implementation: 'cln',
  url: 'https://localhost:3010',
  caCertificate: '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----',
  pubkey: '02' + '11'.repeat(32),
  createdAt: time,
};
const payload = {
  version: 1,
  createdAt: time,
  includesViewCredentials: false,
  settings: {},
  nodes: [node],
  policies: [],
  intents: [],
  restoreCounts: [],
};
const envelope = {
  format: 'lightning-pilot-export',
  version: 1,
  kdf: { name: 'scrypt', N: 131072, r: 8, p: 1, salt: Buffer.alloc(16).toString('base64') },
  cipher: { name: 'aes-256-gcm', nonce: Buffer.alloc(12).toString('base64'), tag: Buffer.alloc(16).toString('base64') },
  ciphertext: 'YWJj',
};

const policy = {
  chain: 'bitcoin',
  pubkey: node.pubkey,
  policy: {
    maxPerPayment: '1000',
    max24h: '2000',
    stepUpAbove: '500',
    maxFeeRate: '10',
    maxFeeSharePercent: 10,
    maxRoutingFeeSharePercent: 1,
    routingFeeAllowance: '1',
  },
};
const intent = {
  id: node.id,
  node_id: node.id,
  chain: 'bitcoin',
  pubkey: node.pubkey,
  type: 'bolt11',
  payment_hash: 'aa'.repeat(32),
  amount_msat: '1000',
  max_fee_msat: '10',
  fee_msat: null,
  cost_msat: null,
  destination: null,
  state: 'unknown',
  idempotency_key: 'retained-replay-key',
  digest: 'bb'.repeat(32),
  session_handle: null,
  confirmation_hash: null,
  txid: null,
  channel_id: null,
  peer: null,
  close_force: null,
  error_code: null,
  created_at: time,
  updated_at: time,
};
const restoreCount = { chain: 'bitcoin', pubkey: node.pubkey, countedMsat: '1000', until: time };

it('rejects malformed Unicode rather than replacing passphrase bytes', () => {
  expect(ExportPassphrase.safeParse('twelve chars ' + '\ud800').success).toBe(false);
  expect(ExportPassphrase.safeParse('twelve chars ' + '🔑').success).toBe(true);
  expect(ExportPassphrase.safeParse('\ufefftwelve chars').success).toBe(true);
});

describe('portable export contracts', () => {
  it('accepts bounded passphrases as exact Unicode code points', () => {
    for (const value of ['a'.repeat(12), 'a'.repeat(128), '🔑'.repeat(128), 'e\u0301'.repeat(6)])
      expect(ExportPassphrase.parse(value)).toBe(value);
    for (const value of ['a'.repeat(11), 'a'.repeat(129), '🔑'.repeat(129), ''])
      expect(ExportPassphrase.safeParse(value).success).toBe(false);
  });

  it('requires exact confirmation and defaults credential export off', () => {
    const passphrase = 'a long enough e\u0301 passphrase';
    expect(ExportRequest.parse({ passphrase, passphraseConfirmation: passphrase }).includeViewCredentials).toBe(false);
    expect(ExportRequest.safeParse({ passphrase, passphraseConfirmation: passphrase.normalize('NFC') }).success).toBe(
      false,
    );
    expect(
      ExportRequest.safeParse({ passphrase, passphraseConfirmation: passphrase, spendRune: 'excluded' }).success,
    ).toBe(false);
  });

  it('allows only the opted-in view credential and excludes spending credentials', () => {
    expect(ExportPayload.safeParse(payload).success).toBe(true);
    const nodes = [{ ...node, viewRune: 'scope-checked-by-adapter' }];
    expect(ExportPayload.safeParse({ ...payload, nodes }).success).toBe(false);
    expect(ExportPayload.safeParse({ ...payload, nodes, includesViewCredentials: true }).success).toBe(true);
    expect(ExportNode.safeParse({ ...node, spendRune: 'excluded' }).success).toBe(false);
    expect(ExportNode.safeParse({ ...node, viewRune: 'x'.repeat(4097) }).success).toBe(false);
  });

  it('rejects excluded secrets rather than silently stripping them', () => {
    for (const key of [
      'owner',
      'passwordHash',
      'totp',
      'recoveryCodes',
      'vaultKey',
      'canary',
      'spendRune',
      'telegramToken',
      'sessions',
      'devices',
      'setupToken',
      'loginToken',
      'throttle',
      'eventCursor',
      'caches',
      'logs',
      'backups',
      'config',
    ])
      expect(ExportPayload.safeParse({ ...payload, [key]: 'excluded' }).success).toBe(false);
    expect(ExportPayload.safeParse({ ...payload, settings: { telegramToken: 'excluded' } }).success).toBe(false);
    expect(ExportNode.safeParse({ ...node, privateKey: 'excluded' }).success).toBe(false);
  });

  it('enforces node, policy, intent and restore count limits', () => {
    expect(ExportPayload.safeParse({ ...payload, nodes: Array.from({ length: 101 }, () => node) }).success).toBe(false);
    for (const [field, limit, value] of [
      ['policies', 100, policy],
      ['intents', 10000, intent],
      ['restoreCounts', 1000, restoreCount],
    ] as const) {
      const atLimit = Array.from({ length: limit }, () => value);
      expect(ExportPayload.safeParse({ ...payload, [field]: atLimit }).success).toBe(true);
      expect(ExportPayload.safeParse({ ...payload, [field]: [...atLimit, value] }).success).toBe(false);
    }
    expect(ExportPayload.safeParse({ ...payload, version: 2 }).success).toBe(false);
    expect(ExportPayload.safeParse({ ...payload, createdAt: 'yesterday' }).success).toBe(false);
  });

  it('retains the spend safety ledger with strict identities and amounts', () => {
    const full = { ...payload, policies: [policy], intents: [intent], restoreCounts: [restoreCount] };
    expect(ExportPayload.safeParse(full).success).toBe(true);
    for (const replacement of [
      { ...intent, amount_msat: 1000 },
      { ...intent, amount_msat: '-1' },
      { ...intent, payment_hash: null },
      { ...intent, type: 'onchain' },
      { ...intent, sessionToken: 'excluded' },
      { ...intent, digest: 'invalid' },
    ])
      expect(ExportPayload.safeParse({ ...full, intents: [replacement] }).success).toBe(false);
    expect(
      ExportPayload.safeParse({ ...full, policies: [{ ...policy, policy: { ...policy.policy, max24h: '1' } }] })
        .success,
    ).toBe(false);
    expect(
      ExportPayload.safeParse({ ...payload, settings: { alerts: { kind: 'telegram', token: 'excluded' } } }).success,
    ).toBe(false);
  });

  it('requires the fixed envelope algorithms and bounded costs', () => {
    expect(ExportEnvelope.safeParse(envelope).success).toBe(true);
    for (const candidate of [
      { ...envelope, version: 2 },
      { ...envelope, format: 'unknown' },
      { ...envelope, kdf: { ...envelope.kdf, N: 2 } },
      { ...envelope, kdf: { ...envelope.kdf, r: 9 } },
      { ...envelope, kdf: { ...envelope.kdf, p: 2 } },
      { ...envelope, kdf: { ...envelope.kdf, name: 'argon2' } },
      { ...envelope, cipher: { ...envelope.cipher, name: 'aes-256-cbc' } },
      { ...envelope, cipher: { ...envelope.cipher, key: 'excluded' } },
      { ...envelope, unknown: true },
      { ...envelope, ciphertext: 'bad!' },
      { ...envelope, ciphertext: 'A'.repeat(5592412) },
    ])
      expect(ExportEnvelope.safeParse(candidate).success).toBe(false);
  });

  it('keeps import request and response fields strict', () => {
    const request = { passphrase: 'a long enough passphrase', envelope };
    expect(ImportRequest.safeParse(request).success).toBe(true);
    expect(ImportRequest.safeParse({ ...request, sourceKey: 'excluded' }).success).toBe(false);
    expect(ImportResponse.safeParse({ nodes: 1, policies: 0, intents: 0, warnings: [] }).success).toBe(true);
    expect(ImportResponse.safeParse({ nodes: -1, policies: 0, intents: 0, warnings: [] }).success).toBe(false);
  });
});
