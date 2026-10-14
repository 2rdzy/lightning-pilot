// Crash recovery on real nodes (spend policy §4, §6): a server process is killed with SIGKILL after the intent is
// committed, once before and once after the node call; the next start marks the intent unknown and resolves it from
// the node. LP_REGTEST_CHAIN selects the chain.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiSession, type ApiSession } from './api-session.ts';
import { invoiceOn, isPaidOn, regtestChain } from './nodes.ts';

const chain = regtestChain();
if (!chain) throw new Error('set LP_REGTEST_CHAIN to blake2b or sha256d');
const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

let session: ApiSession;
beforeAll(async () => {
  session = await apiSession(chain);
});
afterAll(async () => {
  await session.cleanup();
});

// Runs one spend in a separate server process that is killed at the given point; returns the idempotency key.
function crashDuring(
  s: ApiSession,
  job: { kind: string; method: string; body: Record<string, unknown>; at: 'before' | 'after' },
): string {
  const key = `crash-${job.at}-${randomBytes(8).toString('hex')}`;
  const child = spawnSync(
    process.execPath,
    [
      CHILD,
      JSON.stringify({
        dir: s.dir,
        vaultKey: s.vaultKey,
        cookie: s.auth.cookie,
        csrf: s.auth.csrf,
        nodeId: s.nodeId,
        key,
        ...job,
      }),
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  expect(child.signal, `${child.stdout}${child.stderr}`).toBe('SIGKILL');
  return key;
}

const intentOf = async (s: ApiSession, key: string) =>
  s.server.db
    .selectFrom('spend_intents')
    .select(['id', 'state', 'payment_hash', 'fee_msat', 'preimage', 'error_code'])
    .where('idempotency_key', '=', key)
    .executeTakeFirstOrThrow();

describe(`crash recovery on ${chain}`, () => {
  it('BOLT11, killed after the node paid: unknown at start, then succeeded from the node record', async () => {
    await session.suspend();
    const bolt11 = invoiceOn(chain, 'cln-c', 21_000n, `crash-after-${Date.now()}`);
    const key = crashDuring(session, { kind: 'payments', method: 'pay.pay', body: { request: bolt11 }, at: 'after' });
    const server = await session.reopen();
    const marked = await intentOf(session, key);
    expect(marked.state).toBe('unknown');
    expect(isPaidOn(chain, 'cln-c', marked.payment_hash)).toBe(true);
    expect(await server.recovery.resolvePass()).toBe(0);
    const resolved = await intentOf(session, key);
    expect(resolved.state).toBe('succeeded');
    expect(resolved.preimage).toMatch(/^[0-9a-f]{64}$/);
  });

  it('BOLT11, killed before the node call: unknown at start, failed once xpay would have stopped', async () => {
    await session.suspend();
    const bolt11 = invoiceOn(chain, 'cln-c', 22_000n, `crash-before-${Date.now()}`);
    const key = crashDuring(session, { kind: 'payments', method: 'pay.pay', body: { request: bolt11 }, at: 'before' });
    let server = await session.reopen();
    const marked = await intentOf(session, key);
    expect(marked.state).toBe('unknown');
    // Inside xpay's retry window the missing record proves nothing.
    expect(await server.recovery.resolvePass()).toBe(1);
    expect((await intentOf(session, key)).state).toBe('unknown');
    server = await session.reopen({ now: () => new Date(Date.now() + 121_000) });
    expect(await server.recovery.resolvePass()).toBe(0);
    expect(await intentOf(session, key)).toMatchObject({ state: 'failed', error_code: 'not_on_node' });
    expect(isPaidOn(chain, 'cln-c', marked.payment_hash)).toBe(false);
  });
});
