import { expect, it } from 'vitest';
import {
  AddNodeRequest,
  NodeCredentialBlock,
  NodeSetupCommandRequest,
  NodeCredentialStatusResponse,
  ManageNodeRequest,
  ExportNode,
} from './index.ts';
const base = {
  name: 'node',
  chain: 'bitcoin',
  network: 'regtest',
  implementation: 'cln',
  url: 'https://localhost:19320',
  caCertificate: '-----BEGIN CERTIFICATE-----\nY2E=\n-----END CERTIFICATE-----\n',
  viewRune: 'opaque-view',
};
it('keeps legacy setup input compatible and gives management a separate explicit contract', () => {
  expect(AddNodeRequest.parse(base).serverName).toBe('localhost');
  expect(
    ManageNodeRequest.parse({ ...base, accessLevel: 'standard', spendRune: 'opaque-spend' }).adminAcknowledged,
  ).toBe(false);
  expect(AddNodeRequest.safeParse({ ...base, accessLevel: 'standard' }).success).toBe(false);
  expect(ManageNodeRequest.safeParse({ ...base, extra: 'refused' }).success).toBe(false);
});
it('refuses extra, wrong-level and unsupported single-paste credentials', () => {
  const block = { version: 1, implementation: 'cln', accessLevel: 'read-only', viewRune: 'opaque-view' };
  expect(NodeCredentialBlock.safeParse(block).success).toBe(true);
  for (const change of [
    { spendRune: 'unexpected' },
    { extra: 'refused' },
    { implementation: 'lnd' },
    { accessLevel: 'standard' },
  ])
    expect(NodeCredentialBlock.safeParse({ ...block, ...change }).success).toBe(false);
  expect(NodeSetupCommandRequest.safeParse({ accessLevel: 'admin' }).success).toBe(false);
});
it('makes the last-verification spend status explicit and preserves export tombstones', () => {
  expect(
    NodeCredentialStatusResponse.safeParse({
      credentials: { view: 'ok', spend: 'unknown' },
      accessLevel: 'standard',
      adminCredential: false,
      capabilities: [],
      checkedAt: null,
      spendStatusSource: 'last-verification',
    }).success,
  ).toBe(true);
  expect(
    ExportNode.safeParse({
      ...base,
      id: 'b2c913e0-8913-4ab8-8d60-de4fb9fb2216',
      pubkey: '02' + 'aa'.repeat(32),
      createdAt: '2026-10-16T09:00:00.000Z',
      removedAt: '2026-10-16T10:00:00.000Z',
    }).success,
  ).toBe(true);
});
