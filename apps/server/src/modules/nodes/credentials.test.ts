import { describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '@lightning-pilot/adapter-kit';
import { NodeCredentialBlock } from '@lightning-pilot/core';
import { testRune } from '../../testing.ts';
import { inspectRune, setupCommand, verifyRunes } from './credentials.ts';
const rune = (text: string) => Buffer.concat([Buffer.alloc(32, 4), Buffer.from(text)]).toString('base64url');

describe('node credential admission', () => {
  it('accepts exact generated scopes and narrowly restricted features', () => {
    expect(inspectRune(testRune('read'), 'read', 'standard').methods).toContain('getinfo');
    expect(inspectRune(testRune('spend'), 'spend', 'standard').methods).toContain('xpay');
    expect(inspectRune(rune('=7&id!&method=xpay'), 'spend', 'standard').methods).toEqual(['xpay']);
  });
  it.each([
    '=7',
    '=7&id!&method^list',
    '=7&id!&method=createrune',
    '=7&method=xpay',
    '=7&id!&method=xpay|method=listdatastore',
    '=7&id!&method=xpay&time<9',
    '=7&id!&method=xpay\\&method=createrune',
  ])('rejects unsafe shape %s', (text) => {
    expect(() => inspectRune(rune(text), 'spend', 'standard')).toThrow();
  });
  it('limits plugin and setconfig parameters and full management to its explicit level', () => {
    expect(() =>
      inspectRune(
        rune('=7&id!&method=getinfo|method=checkrune|method=getrawblockbyheight|method=plugin'),
        'read',
        'standard',
      ),
    ).toThrow();
    const full = rune(
      '=7&id!&method=xpay|method=setconfig|method=signmessage|method=stop&method/setconfig|pnameconfig=alias|pnameconfig=rgb|pnameconfig=autoclean-cycle',
    );
    expect(inspectRune(full, 'spend', 'full').methods).toContain('stop');
    expect(
      inspectRune(rune('=7&id!&method=setconfig&method/setconfig|pnameconfig=rgb'), 'spend', 'full').config,
    ).toEqual(['rgb']);
    expect(() => inspectRune(full, 'spend', 'standard')).toThrow();
    expect(() => inspectRune(rune('=7&id^&method=xpay'), 'spend', 'full')).toThrow();
  });
  it('accepts unrestricted spend credentials only at the explicit admin level; view remains restricted', () => {
    expect(inspectRune(rune('=7'), 'spend', 'admin').admin).toBe(true);
    expect(() => inspectRune(rune('=7'), 'read', 'admin')).toThrow();
  });
  it('probes through the read adapter, rejects revoked credentials, and refuses a view that can spend', async () => {
    const adapter = new FakeAdapter({ chain: 'blake2b' });
    await verifyRunes(adapter, testRune('read'), testRune('spend'), 'standard');
    const probe = vi.spyOn(adapter.node, 'checkRune');
    probe.mockResolvedValue(false);
    await expect(verifyRunes(adapter, testRune('read'), testRune('spend'), 'standard')).rejects.toMatchObject({
      code: 'node_credential_revoked',
    });
    probe.mockResolvedValue(true);
    await expect(verifyRunes(adapter, testRune('read'), testRune('spend'), 'standard')).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });
  it('generates local commands without downloads and parses only the agreed single-paste keys', () => {
    for (const level of ['read-only', 'standard', 'full'] as const) {
      const command = setupCommand(level);
      expect(command).toContain('lightning-cli createrune');
      expect(command).toContain('jq -n');
      expect(command).not.toMatch(/curl|wget/);
      expect(
        NodeCredentialBlock.safeParse({
          version: 1,
          implementation: 'cln',
          accessLevel: level,
          viewRune: testRune('read'),
          ...(level === 'read-only' ? {} : { spendRune: testRune('spend') }),
        }).success,
      ).toBe(true);
    }
    expect(
      NodeCredentialBlock.safeParse({
        version: 1,
        implementation: 'cln',
        accessLevel: 'read-only',
        viewRune: testRune('read'),
        spendRune: testRune('spend'),
      }).success,
    ).toBe(false);
    expect(
      NodeCredentialBlock.safeParse({
        version: 1,
        implementation: 'cln',
        accessLevel: 'read-only',
        viewRune: testRune('read'),
        extra: 'refused',
      }).success,
    ).toBe(false);
  });
});
