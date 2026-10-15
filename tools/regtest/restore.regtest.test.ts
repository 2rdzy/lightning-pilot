// Restoring the database from a backup on real nodes (update and rollback spec §4, §6 "Rollback"): payments and an
// on-chain send are made after a backup, the backup is restored as the install script's restore mode does, and the
// next start revokes the sessions and counts what the node spent since, before spending is allowed again.
// LP_REGTEST_CHAIN selects the chain.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usedBudget } from '../../apps/server/src/modules/spend/policy.ts';
import { apiSession, ok, type ApiSession } from './api-session.ts';
import { blockCount, cli, invoiceOn, regtest, regtestChain, type RegtestChain } from './nodes.ts';

const selected = regtestChain();
if (!selected) throw new Error('set LP_REGTEST_CHAIN to blake2b or sha256d');
const chain: RegtestChain = selected;

let s: ApiSession;
beforeAll(async () => {
  s = await apiSession(chain);
});
afterAll(async () => {
  await s.cleanup();
});

async function spend<T>(kind: string, body: unknown): Promise<T & { intentId: string; state: string }> {
  const preview = await ok<{ confirmationToken: string }>(
    await s.request('POST', `/api/v1/nodes/${s.nodeId}/${kind}/preview`, body),
  );
  return ok(
    await s.request(
      'POST',
      `/api/v1/nodes/${s.nodeId}/${kind}/execute`,
      { confirmationToken: preview.confirmationToken, acknowledgeDuplicate: true },
      { 'idempotency-key': `restore-${randomBytes(8).toString('hex')}` },
    ),
  );
}

describe(`restore from a backup on ${chain}`, () => {
  it('revokes sessions, pauses spending, and counts the spends made after the backup from the node', async () => {
    const paid = await spend('payments', {
      request: invoiceOn(chain, 'cln-c', 31_000_000n, `restore-a-${Date.now()}`),
    });
    expect(paid.state).toBe('succeeded');
    const node = await s.server.db.selectFrom('nodes').selectAll().where('id', '=', s.nodeId).executeTakeFirstOrThrow();
    const backups = join(s.dir, 'backups');
    mkdirSync(backups, { recursive: true });
    const backup = join(backups, 'pre-regtest.sqlite');
    // A second connection sees the committed state, WAL included.
    const copy = new DatabaseSync(join(s.dir, 'lightning-pilot.db'));
    copy.exec(`VACUUM INTO '${backup}'`);
    copy.close();
    const before = await usedBudget(s.server.db, node, new Date());

    // After the backup: a payment and an on-chain send the restored database will not know.
    const later = await spend('payments', {
      request: invoiceOn(chain, 'cln-c', 32_000_000n, `restore-b-${Date.now()}`),
    });
    expect(later.state).toBe('succeeded');
    const to = (cli(chain, 'cln-b', 'newaddr') as { bech32: string }).bech32;
    const sent = await spend<{ txid: string }>('onchain', { address: to, amount: '43000000', feeRate: '2' });
    expect(sent.state).toBe('succeeded');
    const old = s.auth;

    // The install script's restore mode: stop, copy the backup over, drop the WAL, write the marker.
    await s.suspend();
    copyFileSync(backup, join(s.dir, 'lightning-pilot.db'));
    for (const extra of ['-wal', '-shm']) rmSync(join(s.dir, `lightning-pilot.db${extra}`), { force: true });
    writeFileSync(
      join(s.dir, 'restore.json'),
      JSON.stringify({ version: 1, restoredAt: new Date().toISOString(), backupFile: 'pre-regtest.sqlite' }),
      { mode: 0o600 },
    );
    const server = await s.reopen();
    expect((await s.request('GET', '/api/v1/nodes')).status).toBe(401);
    expect(s.auth).toEqual(old);
    expect(await server.db.selectFrom('sessions').selectAll().execute()).toEqual([]);
    // The restored database knows only the first payment.
    expect(await usedBudget(server.db, node, new Date())).toBe(before);
    expect((await server.db.selectFrom('restore_counts').select('state').execute()).map((r) => r.state)).toEqual([
      'pending',
    ]);

    const unresolved = await server.recovery.resolvePass();
    expect(unresolved, s.lines.filter((l) => l.includes('restore')).join('\n')).toBe(0);
    const counted = await server.db.selectFrom('restore_counts').selectAll().executeTakeFirstOrThrow();
    expect(counted.state).toBe('counted');
    // At least the later payment (amount plus routing fee) and the on-chain send (amount plus fee) are counted. The
    // node's other spends of the last day (other tests, the init script's payments) are counted too, by design.
    expect(BigInt(counted.counted_msat ?? '0')).toBeGreaterThan(32_000_000n + 43_000_000n);
    expect(await usedBudget(server.db, node, new Date())).toBe(before + BigInt(counted.counted_msat ?? '0'));
    // Leave no unconfirmed send behind for the next test file.
    regtest(chain, 'mine', '1');
    const height = blockCount(chain);
    for (const name of ['cln-a', 'cln-b', 'cln-c'])
      while ((cli(chain, name, 'getinfo') as { blockheight: number }).blockheight < height)
        await new Promise((resolve) => setTimeout(resolve, 500));
  });
});
