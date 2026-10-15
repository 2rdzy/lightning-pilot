import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { ExportEnvelope } from '../../packages/core/src/index.ts';
import { buildServer } from '../../apps/server/src/server.ts';
import { setupForTest, tempDir, writeVaultKey } from '../../apps/server/src/testing.ts';
import { sessionDigest } from '../../apps/server/src/modules/sessions/index.ts';
import { totp } from '../../apps/server/src/modules/auth/totp/totp.ts';
import { admissionBudget } from '../../apps/server/src/modules/spend/policy.ts';
import { decryptExport } from '../../apps/server/src/modules/export/crypto.ts';
import { apiSession, ok, serverOptions } from './api-session.ts';
import { invoiceOn, regtestChain } from './nodes.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const chain = regtestChain();
if (!chain) throw new Error('set LP_REGTEST_CHAIN');
it(`exports verified real ${chain} view credentials and reconciles a key-independent import`, async () => {
  const source = await apiSession(chain);
  cleanup.push(() => source.cleanup());
  const invoice = invoiceOn(chain, 'cln-c', 1234000n, `export-${randomBytes(8).toString('hex')}`);
  const preview = await ok<{ confirmationToken: string }>(
    await source.request('POST', `/api/v1/nodes/${source.nodeId}/payments/preview`, { request: invoice }),
  );
  const paid = await ok<{ intentId: string; state: string }>(
    await source.request(
      'POST',
      `/api/v1/nodes/${source.nodeId}/payments/execute`,
      { confirmationToken: preview.confirmationToken, acknowledgeDuplicate: true },
      { 'idempotency-key': `export-${randomBytes(12).toString('hex')}` },
    ),
  );
  expect(paid.state).toBe('succeeded');
  const passphrase = 'real chain portable export passphrase';
  const envelope = ExportEnvelope.parse(
    await ok(
      await source.request('POST', '/api/v1/export', {
        passphrase,
        passphraseConfirmation: passphrase,
        includeViewCredentials: true,
      }),
    ),
  );
  const plain = await decryptExport(envelope, passphrase);
  expect(plain.toString()).toContain('viewRune');
  expect(plain.toString()).not.toContain('spendRune');
  expect(plain.toString()).not.toContain('preimage');
  plain.fill(0);
  await source.suspend();
  const temp = tempDir();
  cleanup.push(temp.cleanup);
  const vaultKey = writeVaultKey(temp.dir),
    lines: string[] = [];
  const target = await buildServer({
    ...serverOptions(temp.dir, vaultKey, lines),
    scryptCost: { log2N: 10, r: 8, p: 1 },
  });
  cleanup.push(() => target.close());
  const token = (JSON.parse(lines.find((l) => l.includes('"setupToken"')) ?? '{}') as { setupToken: string })
    .setupToken;
  const password = 'Destination-regtest-password-9!';
  const setup = await setupForTest(target.setup, token, password);
  const grant = await target.auth.stepUp(
    sessionDigest(setup.reply.sessionCookie ?? ''),
    password,
    'security',
    totp(setup.secret, new Date()),
    'r-import-test',
  );
  await target.exports.run(() => target.exports.import(sessionDigest(grant.cookieValue), { passphrase, envelope }));
  const rows = await target.db.selectFrom('credentials').select(['kind', 'key_id']).execute();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.kind).toBe('read');
  const node = await target.db
    .selectFrom('nodes')
    .selectAll()
    .where('id', '=', source.nodeId)
    .executeTakeFirstOrThrow();
  expect(node.identity_state).toBe('waiting');
  expect(
    (await target.db.selectFrom('spend_intents').selectAll().where('id', '=', paid.intentId).executeTakeFirstOrThrow())
      .preimage,
  ).toBeNull();
  await expect(admissionBudget(target.db, node, new Date(), 1n)).rejects.toMatchObject({ code: 'setup_required' });
  await target.nodes.monitor.ensureChecked(source.nodeId);
  expect(await target.recovery.resolvePass()).toBe(0);
  expect((await target.db.selectFrom('restore_counts').selectAll().execute()).every((c) => c.state === 'counted')).toBe(
    true,
  );
  expect(await admissionBudget(target.db, node, new Date(), 1n)).toBeGreaterThanOrEqual(1234000n);
  expect((await target.nodes.summary(source.nodeId)).canSpend).toBe(false);
  expect(lines.join('\n')).not.toContain(passphrase);
});
