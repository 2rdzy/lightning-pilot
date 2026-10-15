import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runeRestrictions } from '@lightning-pilot/adapter-cln';
import { SpendPolicy, ExportPayload } from '@lightning-pilot/core';
import { createLogger } from '../../logging/logger.ts';
import { setupForTest, tempDir, testDb } from '../../testing.ts';
import { AuthService } from '../auth/index.ts';
import { totp } from '../auth/totp/totp.ts';
import { NodesService } from '../nodes/index.ts';
import { SetupService } from '../setup/index.ts';
import { sessionDigest } from '../sessions/service.ts';
import { Vault } from '../vault/index.ts';
import { admissionBudget } from '../spend/policy.ts';
import { encryptExport, decryptExport } from './crypto.ts';
import * as crypto from './crypto.ts';
import { ExportService } from './service.ts';

const PASSWORD = 'Synthetic-Export-Password-123!';
const PASS = 'a long synthetic export passphrase';
const NOW = '2026-10-15T12:00:00.000Z';
const PUB = '02' + 'ab'.repeat(32);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Missing test fixture');
  return value;
}
let certificate: string;
function ca() {
  if (!certificate) {
    const t = tempDir();
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:P-256',
          '-nodes',
          '-keyout',
          join(t.dir, 'key'),
          '-out',
          join(t.dir, 'cert'),
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
        ],
        { stdio: 'ignore' },
      );
      certificate = readFileSync(join(t.dir, 'cert'), 'utf8');
    } finally {
      t.cleanup();
    }
  }
  return certificate;
}
const safeRune = () => {
  const clauses = JSON.parse(runeRestrictions('read')) as string[][];
  return Buffer.concat([
    Buffer.alloc(32, 255),
    Buffer.from('=7&' + clauses.map((clause) => clause.join('|')).join('&')),
  ])
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
};
async function harness(options: { dev?: boolean; maxNodes?: number } = {}) {
  const t = tempDir();
  const { db, raw } = await testDb(t.dir);
  const key = randomBytes(32);
  const vault = await Vault.start(db, key);
  key.fill(0);
  const logs: string[] = [];
  const clock = { now: new Date(NOW) };
  const logger = createLogger({ sink: (line) => logs.push(line), stdout: (line) => logs.push(line) });
  const cost = { log2N: 10, r: 8, p: 1 };
  const auth = await AuthService.create({
    db,
    raw,
    vault,
    logger,
    setupUrl: 'https://localhost/setup',
    scryptCost: cost,
    now: () => clock.now,
  });
  const nodes = new NodesService({ db, vault, logger, dev: true, maxNodes: 10, now: () => clock.now });
  const setup = new SetupService({ db, vault, auth, nodes, logger, scryptCost: cost, now: () => clock.now });
  await auth.issueSetupToken();
  const token = (JSON.parse(logs.find((line) => line.includes('"setupToken"')) ?? '{}') as { setupToken: string })
    .setupToken;
  const enrolled = await setupForTest(setup, token, PASSWORD, clock.now);
  const initial = sessionDigest(enrolled.reply.sessionCookie ?? '');
  const stepped = await auth.stepUp(initial, PASSWORD, 'security', totp(enrolled.secret, clock.now), 'export-test');
  const idHash = sessionDigest(stepped.cookieValue);
  const service = new ExportService({
    db,
    vault,
    auth,
    logger,
    dev: options.dev ?? true,
    maxNodes: options.maxNodes ?? 10,
    now: () => clock.now,
  });
  cleanups.push(async () => {
    await service.close();
    setup.close();
    await nodes.monitor.stop();
    auth.sessions.close();
    vault.close();
    await db.destroy();
    t.cleanup();
  });
  return { db, raw, vault, auth, service, logs, clock, idHash, initial };
}
function payload(): ExportPayload {
  const id = randomUUID();
  return {
    version: 1,
    createdAt: NOW,
    includesViewCredentials: false,
    settings: {},
    nodes: [
      {
        id,
        name: 'Synthetic node',
        chain: 'blake2b',
        network: 'regtest',
        implementation: 'cln',
        url: 'https://localhost:9999',
        caCertificate: ca(),
        serverName: 'localhost',
        pubkey: PUB,
        createdAt: NOW,
      },
    ],
    policies: [],
    intents: [
      {
        id: randomUUID(),
        node_id: id,
        chain: 'blake2b',
        pubkey: PUB,
        type: 'bolt11',
        payment_hash: 'aa'.repeat(32),
        amount_msat: '1000',
        max_fee_msat: '100',
        fee_msat: null,
        cost_msat: '1100',
        destination: null,
        state: 'sent',
        idempotency_key: randomUUID(),
        digest: 'bb'.repeat(32),
        session_handle: randomUUID(),
        confirmation_hash: 'cc'.repeat(32),
        txid: null,
        channel_id: null,
        peer: null,
        close_force: null,
        error_code: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    restoreCounts: [{ chain: 'blake2b', pubkey: PUB, countedMsat: '250', until: '2026-10-16T11:00:00.000Z' }],
  };
}
async function envelope(data: unknown) {
  return encryptExport(Buffer.from(JSON.stringify(data)), PASS);
}
const exportRequest = { passphrase: PASS, passphraseConfirmation: PASS };

describe('encrypted export lifecycle', () => {
  it('imports public settings, reloads session deadlines and accepts semantically equal settings', async () => {
    const h = await harness();
    await h.db.deleteFrom('settings').where('key', 'in', ['session_policy', 'setup_alerts']).execute();
    const data = payload();
    data.settings = {
      sessionPolicy: { idleSeconds: 600, absoluteSeconds: 7200 },
      alerts: {
        kind: 'nostr',
        recipient: 'npub1pv9skzctpv9skzctpv9skzctpv9skzctpv9skzctpv9skzctpv9sx6pysv',
        relays: ['wss://relay.example.org'],
      },
    };
    await h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(data) });
    expect(await h.auth.sessions.policy(h.idHash)).toEqual(data.settings.sessionPolicy);
    const row = await h.db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'session_policy')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.value)).toEqual(data.settings.sessionPolicy);
    // Stored key order and whitespace must not turn an equal policy into a conflict.
    await h.db
      .updateTable('settings')
      .set({ value: '{ "absoluteSeconds":7200, "idleSeconds":600 }' })
      .where('key', '=', 'session_policy')
      .execute();
    const incoming = payload();
    first(incoming.nodes).pubkey = '03' + 'cd'.repeat(32);
    first(incoming.intents).pubkey = first(incoming.nodes).pubkey;
    incoming.restoreCounts = [];
    incoming.settings = data.settings;
    await h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(incoming) });
    const plain = await decryptExport(await h.service.export(h.idHash, exportRequest), PASS);
    expect((JSON.parse(plain.toString()) as ExportPayload).settings).toEqual(data.settings);
    plain.fill(0);
    h.clock.now = new Date(Date.parse(NOW) + 600001);
    await expect(h.auth.sessions.live(h.db, h.idHash)).rejects.toBeDefined();
  });

  it('omits sealed Telegram settings and permits opted-in export when a node has no read credential', async () => {
    const h = await harness();
    const data = payload();
    await h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(data) });
    const sealed = h.vault.sealSecret('123456:'.padEnd(42, 'a'), 'telegram_token');
    await h.db
      .insertInto('settings')
      .values({
        key: 'setup_alerts',
        value: JSON.stringify({
          kind: 'telegram',
          key_id: sealed.key_id,
          nonce: sealed.nonce.toString('base64'),
          ciphertext: sealed.ciphertext.toString('base64'),
        }),
      })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value: JSON.stringify({
            kind: 'telegram',
            key_id: sealed.key_id,
            nonce: sealed.nonce.toString('base64'),
            ciphertext: sealed.ciphertext.toString('base64'),
          }),
        }),
      )
      .execute();
    const plain = await decryptExport(
      await h.service.export(h.idHash, { ...exportRequest, includeViewCredentials: true }),
      PASS,
    );
    const exported = JSON.parse(plain.toString()) as ExportPayload;
    expect(exported.settings).not.toHaveProperty('alerts');
    expect(first(exported.nodes)).not.toHaveProperty('viewRune');
    expect(plain.includes(sealed.ciphertext)).toBe(false);
    plain.fill(0);
  });

  it('rejects unsafe node profiles, inconsistent ledger identities and future timestamps atomically', async () => {
    const h = await harness();
    const mutations: ((data: ExportPayload) => void)[] = [
      (d) => {
        first(d.nodes).url = 'https://user:password@localhost:9999';
      },
      (d) => {
        first(d.nodes).url = 'https://:password@localhost:9999';
      },
      (d) => {
        first(d.nodes).url += '?token=secret';
      },
      (d) => {
        first(d.nodes).url += '#fragment';
      },
      (d) => {
        first(d.nodes).network = 'signet';
      },
      (d) => {
        first(d.nodes).createdAt = '2026-10-15T12:00:00.001Z';
      },
      (d) => {
        first(d.intents).created_at = '2026-10-15T12:00:00.001Z';
      },
      (d) => {
        first(d.intents).updated_at = '2026-10-15T12:00:00.001Z';
      },
      (d) => {
        first(d.intents).updated_at = '2026-10-15T11:59:59.999Z';
      },
      (d) => {
        first(d.intents).chain = 'bitcoin';
      },
      (d) => {
        first(d.intents).pubkey = '03' + 'cd'.repeat(32);
      },
      (d) => {
        first(d.restoreCounts).until = '2026-10-16T12:00:00.001Z';
      },
      (d) => {
        d.includesViewCredentials = true;
        first(d.nodes).viewRune = Buffer.concat([Buffer.alloc(32), Buffer.from('=1')]).toString('base64url');
      },
      (d) => {
        d.nodes.push({ ...first(d.nodes), id: randomUUID() });
      },
      (d) => {
        d.intents.push({ ...first(d.intents), idempotency_key: randomUUID() });
      },
      (d) => {
        d.intents.push({ ...first(d.intents), id: randomUUID() });
      },
    ];
    for (const mutate of mutations) {
      const data = payload();
      mutate(data);
      await expect(
        h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(data) }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(await h.db.selectFrom('nodes').selectAll().execute()).toEqual([]);
      expect(await h.db.selectFrom('restores').selectAll().execute()).toEqual([]);
    }
  }, 30000);

  it('refuses regtest imports in production mode', async () => {
    const h = await harness({ dev: false });
    await expect(
      h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(payload()) }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await h.db.selectFrom('nodes').selectAll().execute()).toEqual([]);
  });

  it('refuses configured node-count overflow and same identity under a new UUID', async () => {
    const h = await harness({ maxNodes: 1 });
    const data = payload();
    await h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(data) });
    const incoming = payload();
    first(incoming.nodes).pubkey = '03' + 'cd'.repeat(32);
    first(incoming.intents).pubkey = first(incoming.nodes).pubkey;
    await expect(
      h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(incoming) }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const other = await harness();
    await other.service.import(other.idHash, { passphrase: PASS, envelope: await envelope(data) });
    await expect(
      other.service.import(other.idHash, { passphrase: PASS, envelope: await envelope(payload()) }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await other.db.selectFrom('nodes').selectAll().execute()).toHaveLength(1);
  });

  it('rejects malformed direct requests and encrypted invalid UTF-8 or JSON without writes', async () => {
    const h = await harness();
    await expect(
      h.service.export(h.idHash, { ...exportRequest, passphraseConfirmation: 'different passphrase' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(h.service.import(h.idHash, { passphrase: PASS, envelope: {} })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    for (const plain of [Buffer.from([0xc3, 0x28]), Buffer.from('{invalid-json')])
      await expect(
        h.service.import(h.idHash, { passphrase: PASS, envelope: await encryptExport(plain, PASS) }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await h.db.selectFrom('nodes').selectAll().execute()).toEqual([]);
    expect(await h.db.selectFrom('restores').selectAll().execute()).toEqual([]);
  });

  it('refuses corrupt stored settings and invalid stored node records', async () => {
    const h = await harness();
    await h.db
      .insertInto('settings')
      .values({ key: 'session_policy', value: '{corrupt' })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: '{corrupt' }))
      .execute();
    await expect(h.service.export(h.idHash, exportRequest)).rejects.toMatchObject({ code: 'validation_failed' });
    await h.db.deleteFrom('settings').where('key', '=', 'session_policy').execute();
    await h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(payload()) });
    await h.db.updateTable('nodes').set({ name: '' }).execute();
    await expect(h.service.export(h.idHash, exportRequest)).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('releases its reserved lane after thrown work', async () => {
    const h = await harness();
    await expect(
      h.service.run(async () => {
        throw new Error('synthetic lane failure');
      }),
    ).rejects.toThrow('synthetic lane failure');
    expect(await h.service.run(async () => 'available')).toBe('available');
  });

  it('refuses a valid retained ledger whose serialized export exceeds the plaintext size bound', async () => {
    const h = await harness();
    await h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(payload()) });
    const row = await h.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow();
    // History is never silently truncated to fit a file. Modest row count, maximum supported destination length.
    for (let batch = 0; batch < 11; batch++) {
      await h.db
        .insertInto('spend_intents')
        .values(
          Array.from({ length: 100 }, () => ({
            ...row,
            id: randomUUID(),
            idempotency_key: randomUUID(),
            payment_hash: randomBytes(32).toString('hex'),
            destination: 'd'.repeat(4096),
          })),
        )
        .execute();
    }
    await expect(h.service.export(h.idHash, exportRequest)).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await h.db.selectFrom('spend_intents').select('id').execute()).toHaveLength(1101);
  });

  it('imports without a source vault key, reseals only read credentials, preserves replay and carries budget barriers', async () => {
    const source = await harness();
    const data = payload();
    data.includesViewCredentials = true;
    first(data.nodes).viewRune = safeRune();
    await source.service.import(source.idHash, { passphrase: PASS, envelope: await envelope(data) });
    const nodeId = first(data.nodes).id;
    await source.vault.put(source.db, nodeId, 'spend', 'excluded-spend-canary');
    await source.db
      .updateTable('spend_intents')
      .set({
        preimage: 'ee'.repeat(32),
        psbt_key_id: 'excluded-psbt-key',
        psbt_nonce: Buffer.alloc(12, 11),
        psbt_ciphertext: Buffer.from('excluded-psbt-ciphertext'),
      })
      .execute();
    const output = await source.service.export(source.idHash, { ...exportRequest, includeViewCredentials: true });
    const plain = await decryptExport(output, PASS);
    const text = plain.toString('utf8');
    const exported = JSON.parse(text) as ExportPayload;
    plain.fill(0);
    for (const excluded of [
      'excluded-spend-canary',
      'excluded-psbt',
      'preimage',
      'password_hash',
      'auth_totp',
      'recovery_codes',
      'sessionCookie',
      'vault_canary',
      'setupToken',
      'ee'.repeat(32),
    ])
      expect(text).not.toContain(excluded);
    expect(first(exported.nodes).viewRune).toBe(safeRune());
    expect(exported.intents[0]).toMatchObject({
      id: first(data.intents).id,
      state: 'unknown',
      idempotency_key: first(data.intents).idempotency_key,
      session_handle: first(data.intents).session_handle,
      confirmation_hash: first(data.intents).confirmation_hash,
    });
    source.vault.close();
    const destination = await harness();
    await destination.service.import(destination.idHash, { passphrase: PASS, envelope: output });
    expect(await destination.vault.get(destination.db, nodeId, 'read')).toBe(safeRune());
    expect(await destination.vault.get(destination.db, nodeId, 'spend')).toBeUndefined();
    const intent = await destination.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow();
    expect(intent).toMatchObject({
      state: 'unknown',
      preimage: null,
      psbt_key_id: null,
      psbt_nonce: null,
      psbt_ciphertext: null,
    });
    expect(
      await destination.db.selectFrom('restore_counts').selectAll().where('state', '=', 'counted').execute(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ counted_msat: '250', until: first(data.restoreCounts).until }),
      ]),
    );
    await expect(
      admissionBudget(destination.db, { chain: 'blake2b', pubkey: PUB }, destination.clock.now, 1n),
    ).rejects.toMatchObject({ code: 'setup_required' });
    expect(destination.logs.join('\n')).not.toContain(PASS);
    expect(destination.logs.join('\n')).not.toContain(safeRune());
  });
  it('omits view credentials by default and refuses broad read-labelled credentials only on opt-in', async () => {
    const h = await harness();
    const data = payload();
    await h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(data) });
    await h.vault.put(
      h.db,
      first(data.nodes).id,
      'read',
      Buffer.concat([Buffer.alloc(32), Buffer.from('=1')]).toString('base64url'),
    );
    const plain = await decryptExport(await h.service.export(h.idHash, exportRequest), PASS);
    expect((JSON.parse(plain.toString()) as ExportPayload).nodes[0]).not.toHaveProperty('viewRune');
    plain.fill(0);
    await expect(h.service.export(h.idHash, { ...exportRequest, includeViewCredentials: true })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
  it('rejects repeated import without changing destination history or encrypted credentials', async () => {
    const h = await harness();
    const input = { passphrase: PASS, envelope: await envelope(payload()) };
    await h.service.import(h.idHash, input);
    const before = {
      nodes: await h.db.selectFrom('nodes').selectAll().execute(),
      intents: await h.db.selectFrom('spend_intents').selectAll().execute(),
      counts: await h.db.selectFrom('restore_counts').selectAll().execute(),
      restores: await h.db.selectFrom('restores').selectAll().execute(),
    };
    await expect(h.service.import(h.idHash, input)).rejects.toMatchObject({ code: 'validation_failed' });
    expect({
      nodes: await h.db.selectFrom('nodes').selectAll().execute(),
      intents: await h.db.selectFrom('spend_intents').selectAll().execute(),
      counts: await h.db.selectFrom('restore_counts').selectAll().execute(),
      restores: await h.db.selectFrom('restores').selectAll().execute(),
    }).toEqual(before);
  });
  it.each(['duplicate', 'reference', 'certificate', 'future', 'spendRune'] as const)(
    'rejects %s payload atomically',
    async (kind) => {
      const h = await harness();
      const data = payload();
      if (kind === 'duplicate') data.nodes.push({ ...first(data.nodes) });
      if (kind === 'reference') first(data.intents).node_id = randomUUID();
      if (kind === 'certificate')
        first(data.nodes).caCertificate = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
      if (kind === 'future') data.createdAt = '2026-10-16T12:00:00.000Z';
      if (kind === 'spendRune') Object.assign(first(data.nodes), { spendRune: 'never-accepted-canary' });
      await expect(
        h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(data) }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(await h.db.selectFrom('nodes').selectAll().execute()).toEqual([]);
      expect(await h.db.selectFrom('restores').selectAll().execute()).toEqual([]);
    },
  );
  it('rolls back profiles, sealed credentials and ledger when a late SQL insert fails', async () => {
    const h = await harness();
    const data = payload();
    data.includesViewCredentials = true;
    first(data.nodes).viewRune = safeRune();
    h.raw.exec(
      "CREATE TRIGGER abort_import BEFORE INSERT ON restore_counts BEGIN SELECT RAISE(ABORT, 'synthetic import failure'); END",
    );
    await expect(h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(data) })).rejects.toThrow(
      'synthetic import failure',
    );
    for (const table of ['nodes', 'credentials', 'spend_intents', 'restores', 'restore_counts'] as const)
      expect(await h.db.selectFrom(table).selectAll().execute()).toEqual([]);
  });
  it.each(['policy', 'intent UUID', 'replay key', 'settings'] as const)(
    'refuses %s collisions without touching destination safety history',
    async (kind) => {
      const h = await harness();
      const original = payload();
      original.settings.sessionPolicy = { idleSeconds: 3600, absoluteSeconds: 86400 };
      original.policies.push({
        chain: 'blake2b',
        pubkey: PUB,
        policy: SpendPolicy.parse({
          maxPerPayment: '100',
          max24h: '200',
          stepUpAbove: '50',
          maxFeeRate: '3',
          maxFeeSharePercent: 5,
          maxRoutingFeeSharePercent: 1,
          routingFeeAllowance: '10',
        }),
      });
      await h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(original) });
      const incoming = payload();
      const otherPubkey = '03' + 'cd'.repeat(32);
      first(incoming.nodes).pubkey = otherPubkey;
      first(incoming.intents).pubkey = otherPubkey;
      incoming.restoreCounts = [];
      if (kind === 'policy') incoming.policies = original.policies;
      if (kind === 'intent UUID') first(incoming.intents).id = first(original.intents).id;
      if (kind === 'replay key') first(incoming.intents).idempotency_key = first(original.intents).idempotency_key;
      if (kind === 'settings') incoming.settings.sessionPolicy = { idleSeconds: 1800, absoluteSeconds: 86400 };
      const before = {
        limits: await h.db.selectFrom('spend_limits').selectAll().execute(),
        intents: await h.db.selectFrom('spend_intents').selectAll().execute(),
        counts: await h.db.selectFrom('restore_counts').selectAll().execute(),
        restores: await h.db.selectFrom('restores').selectAll().execute(),
        settings: await h.db.selectFrom('settings').selectAll().execute(),
      };
      await expect(
        h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(incoming) }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect({
        limits: await h.db.selectFrom('spend_limits').selectAll().execute(),
        intents: await h.db.selectFrom('spend_intents').selectAll().execute(),
        counts: await h.db.selectFrom('restore_counts').selectAll().execute(),
        restores: await h.db.selectFrom('restores').selectAll().execute(),
        settings: await h.db.selectFrom('settings').selectAll().execute(),
      }).toEqual(before);
      expect(await h.db.selectFrom('nodes').selectAll().execute()).toHaveLength(1);
    },
  );
  it('preserves all resolved states and converts every uncertain in-flight state to unknown', async () => {
    const h = await harness();
    const data = payload();
    const base = first(data.intents);
    data.intents = (['reserved', 'sent', 'unknown', 'succeeded', 'failed'] as const).map((state, n) => ({
      ...base,
      id: randomUUID(),
      idempotency_key: randomUUID(),
      payment_hash: n.toString(16).repeat(64),
      state,
    }));
    // Mixed valid ISO precisions describe increasing times and must compare by instant.
    first(data.intents).created_at = '2026-10-15T11:00:00Z';
    first(data.intents).updated_at = '2026-10-15T11:00:00.001Z';
    await h.service.import(h.idHash, { passphrase: PASS, envelope: await envelope(data) });
    const rows = await h.db.selectFrom('spend_intents').selectAll().execute();
    expect(rows.map((row) => row.state)).toEqual(['unknown', 'unknown', 'unknown', 'succeeded', 'failed']);
    expect(first(rows).created_at).toBe(new Date(first(data.intents).created_at).toISOString());
  });
  it('checks authorization before export and again after encryption before releasing data', async () => {
    const h = await harness();
    await expect(h.service.export(h.initial, exportRequest)).rejects.toBeDefined();
    const original = crypto.encryptExport;
    let ready = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(crypto, 'encryptExport').mockImplementation(async (...args) => {
      const result = await original(...args);
      ready();
      await gate;
      return result;
    });
    const pending = h.service.export(h.idHash, exportRequest);
    await started;
    h.clock.now = new Date(Date.parse(NOW) + 300000);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'step_up_required' });
    release();
    await rejected;
  });
  it('rechecks the live session after decryption and commits nothing if revoked meanwhile', async () => {
    const h = await harness();
    const input = { passphrase: PASS, envelope: await envelope(payload()) };
    const original = crypto.decryptExport;
    let ready = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(crypto, 'decryptExport').mockImplementation(async (...args) => {
      const result = await original(...args);
      ready();
      await gate;
      return result;
    });
    const pending = h.service.import(h.idHash, input);
    await started;
    const session = await h.auth.sessions.live(h.db, h.idHash);
    await h.auth.sessions.end(session.handle, 'revoked');
    const rejected = expect(pending).rejects.toBeDefined();
    release();
    await rejected;
    expect(await h.db.selectFrom('nodes').selectAll().execute()).toEqual([]);
    expect(await h.db.selectFrom('restores').selectAll().execute()).toEqual([]);
  });
  it('serializes operation reservation and drains it on shutdown, including thrown work', async () => {
    const h = await harness();
    let release = () => {};
    const first = h.service.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(h.service.run(async () => undefined)).rejects.toMatchObject({ code: 'busy' });
    let closed = false;
    const close = h.service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await first;
    await close;
    expect(closed).toBe(true);
    await expect(h.service.run(async () => undefined)).rejects.toMatchObject({ code: 'busy' });
  });
  it('refuses over-limit collections before item-schema validation allocates errors', async () => {
    const h = await harness();
    for (const key of ['nodes', 'policies', 'intents', 'restoreCounts', 'relays'] as const) {
      const data: Record<string, unknown> = { ...payload() };
      if (key === 'relays') data.settings = { alerts: { kind: 'nostr', relays: Array(6).fill(null) } };
      else data[key] = Array({ nodes: 100, policies: 100, intents: 10000, restoreCounts: 1000 }[key] + 1).fill(null);
      const encrypted = await envelope(data);
      const parse = vi.spyOn(ExportPayload, 'parse');
      await expect(h.service.import(h.idHash, { passphrase: PASS, envelope: encrypted })).rejects.toMatchObject({
        code: 'validation_failed',
      });
      expect(parse).not.toHaveBeenCalled();
      parse.mockRestore();
    }
    expect(await h.db.selectFrom('nodes').selectAll().execute()).toEqual([]);
  }, 20000);
  it('refuses future-dated spends until the destination clock catches up, without losing budget or timestamps', async () => {
    const h = await harness();
    const data = payload();
    data.createdAt = new Date(Date.parse(NOW) + 60000).toISOString();
    first(data.intents).created_at = new Date(Date.parse(NOW) + 1000).toISOString();
    first(data.intents).updated_at = first(data.intents).created_at;
    const file = { passphrase: PASS, envelope: await envelope(data) };
    await expect(h.service.import(h.idHash, file)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'future_spend_time' },
    });
    expect(await h.db.selectFrom('spend_intents').selectAll().execute()).toEqual([]);
    expect(await h.db.selectFrom('restores').selectAll().execute()).toEqual([]);
    h.clock.now = new Date(Date.parse(NOW) + 1000);
    await h.service.import(h.idHash, file);
    const stored = await h.db.selectFrom('spend_intents').selectAll().executeTakeFirstOrThrow();
    expect(stored.created_at).toBe(first(data.intents).created_at);
    const { usedBudget } = await import('../spend/policy.ts');
    expect(await usedBudget(h.db, { chain: 'blake2b', pubkey: PUB }, h.clock.now)).toBeGreaterThanOrEqual(1100n);
  });
});
