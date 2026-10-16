import { execFileSync } from 'node:child_process';
import { afterAll, expect, it } from 'vitest';
import { NodeCredentialBlock } from '../../packages/core/src/index.ts';
import { setupCommand, inspectRune } from '../../apps/server/src/modules/nodes/credentials.ts';
import { apiSession, ok, type ApiSession } from './api-session.ts';
import { SCRIPT, cli, creds, profileOf, regtest, regtestChain } from './nodes.ts';

const chain = regtestChain();
if (!chain) throw new Error('set LP_REGTEST_CHAIN');
let session: ApiSession | undefined;
const createdIds: string[] = [];
afterAll(async () => {
  // Only the runes created by this test are revoked; the shared environment's credentials stay usable.
  for (const id of createdIds) regtest(chain, 'cli', 'cln-a', 'blacklistrune', id);
  await session?.cleanup();
});
function block(level: 'read-only' | 'standard' | 'full') {
  const command = setupCommand(level);
  const out = execFileSync(
    'bash',
    ['-c', 'lightning-cli() { "$LP_NODE_SCRIPT" "$LP_NODE_CHAIN" cli cln-a "$@"; };\n' + command],
    { encoding: 'utf8', env: { ...process.env, LP_NODE_SCRIPT: SCRIPT, LP_NODE_CHAIN: chain } },
  );
  const parsed = NodeCredentialBlock.parse(JSON.parse(out) as unknown);
  createdIds.push(inspectRune(parsed.viewRune, 'read', level).id);
  if (parsed.spendRune) createdIds.push(inspectRune(parsed.spendRune, 'spend', level).id);
  return parsed;
}
it('checks generated single-paste credentials, access levels, revocation and removal on the selected chain', async () => {
  session = await apiSession(chain);
  const s = session;
  const connection = creds(chain, 'cln-a', 'view');
  const input = {
    name: 'managed',
    chain: profileOf(chain),
    network: 'regtest',
    implementation: 'cln',
    url: connection.url,
    caCertificate: connection.caCertificate,
  };
  const admin = cli(chain, 'cln-a', 'createrune') as { rune: string };
  createdIds.push(inspectRune(admin.rune, 'spend', 'admin').id);
  expect(
    (
      await s.request('PUT', `/api/v1/nodes/${s.nodeId}`, {
        ...input,
        viewRune: connection.rune,
        spendRune: admin.rune,
        accessLevel: 'admin',
      })
    ).status,
  ).toBe(403);
  const marked = await ok<{ adminCredential: boolean }>(
    await s.request('PUT', `/api/v1/nodes/${s.nodeId}`, {
      ...input,
      viewRune: connection.rune,
      spendRune: admin.rune,
      accessLevel: 'admin',
      adminAcknowledged: true,
    }),
  );
  expect(marked.adminCredential).toBe(true);
  const full = block('full');
  const rejected = await s.request('PUT', `/api/v1/nodes/${s.nodeId}`, {
    ...input,
    viewRune: full.viewRune,
    spendRune: full.spendRune,
    accessLevel: 'standard',
  });
  expect(rejected.status).toBe(403);
  const replaced = await ok<{ accessLevel: string; adminCredential: boolean }>(
    await s.request('PUT', `/api/v1/nodes/${s.nodeId}`, { ...input, credentialBlock: JSON.stringify(full) }),
  );
  expect(replaced).toMatchObject({ accessLevel: 'full', adminCredential: false });
  const status = await ok<{ credentials: { view: string; spend: string } }>(
    await s.request('POST', `/api/v1/nodes/${s.nodeId}/credentials/check`),
  );
  expect(status.credentials).toEqual({ view: 'ok', spend: 'ok' });
  const spendId = inspectRune(full.spendRune ?? '', 'spend', 'full').id;
  regtest(chain, 'cli', 'cln-a', 'blacklistrune', spendId);
  createdIds.splice(createdIds.indexOf(spendId), 1);
  expect((await s.request('POST', `/api/v1/nodes/${s.nodeId}/credentials/check`)).status).toBe(409);
  const revoked = await ok<{ credentials: { view: string; spend: string } }>(
    await s.request('GET', `/api/v1/nodes/${s.nodeId}/credentials`),
  );
  expect(revoked.credentials).toEqual({ view: 'ok', spend: 'revoked' });
  const readOnly = block('read-only');
  const updated = await ok<{ canSpend: boolean }>(
    await s.request('PUT', `/api/v1/nodes/${s.nodeId}`, { ...input, credentialBlock: JSON.stringify(readOnly) }),
  );
  expect(updated.canSpend).toBe(false);
  const viewId = inspectRune(readOnly.viewRune, 'read', 'read-only').id;
  regtest(chain, 'cli', 'cln-a', 'blacklistrune', viewId);
  createdIds.splice(createdIds.indexOf(viewId), 1);
  const viewRevoked = await ok<{ credentials: { view: string; spend: string } }>(
    await s.request('GET', `/api/v1/nodes/${s.nodeId}/credentials`),
  );
  expect(viewRevoked.credentials).toEqual({ view: 'revoked', spend: 'missing' });
  expect((await s.request('DELETE', `/api/v1/nodes/${s.nodeId}`)).status).toBe(204);
  expect((await s.request('GET', `/api/v1/nodes/${s.nodeId}`)).status).toBe(404);
});
