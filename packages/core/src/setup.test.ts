import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { LoginRequest, Password } from './api.ts';
import { SetupAction, SetupAlerts, SetupLimits } from './setup.ts';

describe('setup security input contracts', () => {
  it('accepts password length boundaries and rejects each missing character class', () => {
    for (const length of [12, 128]) expect(Password.safeParse(`Aa1!${'x'.repeat(length - 4)}`).success).toBe(true);
    for (const password of [
      'Aa1!xxxxxxx',
      `Aa1!${'x'.repeat(125)}`,
      'AAAAAAAAAA1!',
      'aaaaaaaaaa1!',
      'AaAAAAAAAAA!',
      'Aa1111111111',
    ]) {
      expect(Password.safeParse(password).success).toBe(false);
    }
  });

  const limits = {
    maxPerPayment: null,
    max24h: null,
    stepUpAbove: null,
    maxFeeRate: '1',
    maxFeeSharePercent: 5,
    maxRoutingFeeSharePercent: 1,
    routingFeeAllowance: '10',
  };
  it('accepts explicit unlimited choices and exact amount/rate boundaries', () => {
    expect(SetupLimits.safeParse(limits).success).toBe(true);
    for (const amount of ['0', '999999999999999999']) {
      expect(
        SetupLimits.safeParse({
          ...limits,
          maxPerPayment: amount,
          max24h: amount,
          stepUpAbove: amount,
          routingFeeAllowance: amount,
        }).success,
      ).toBe(true);
    }
    for (const maxFeeRate of ['0.001', '9999999.999'])
      expect(SetupLimits.safeParse({ ...limits, maxFeeRate }).success).toBe(true);
    for (const maxFeeSharePercent of [1, 100])
      expect(SetupLimits.safeParse({ ...limits, maxFeeSharePercent }).success).toBe(true);
    for (const maxRoutingFeeSharePercent of [0, 100])
      expect(SetupLimits.safeParse({ ...limits, maxRoutingFeeSharePercent }).success).toBe(true);
  });
  it('rejects ambiguous amounts, excessive precision and invalid percentages', () => {
    for (const amount of ['01', '-1', '1.1', '1e3', '1000000000000000000', '']) {
      for (const field of ['maxPerPayment', 'max24h', 'stepUpAbove', 'routingFeeAllowance'])
        expect(SetupLimits.safeParse({ ...limits, [field]: amount }).success).toBe(false);
    }
    for (const maxFeeRate of ['0', '0.000', '01', '-1', '1.0001', '10000000', '1e3'])
      expect(SetupLimits.safeParse({ ...limits, maxFeeRate }).success).toBe(false);
    for (const maxFeeSharePercent of [0, 101, 1.5])
      expect(SetupLimits.safeParse({ ...limits, maxFeeSharePercent }).success).toBe(false);
    for (const maxRoutingFeeSharePercent of [-1, 101, 1.5])
      expect(SetupLimits.safeParse({ ...limits, maxRoutingFeeSharePercent }).success).toBe(false);
  });

  const recipient = bech32.encode('npub', bech32.toWords(new Uint8Array(32).fill(1)));
  it('validates Nostr identity checksum, prefix, key length and secure relays', () => {
    expect(SetupAlerts.safeParse({ kind: 'nostr', recipient, relays: ['wss://relay.example'] }).success).toBe(true);
    for (const invalid of [
      recipient.slice(0, -1) + 'q',
      bech32.encode('nsec', bech32.toWords(new Uint8Array(32))),
      bech32.encode('npub', bech32.toWords(new Uint8Array(31))),
      'npub-not-bech32',
    ]) {
      expect(
        SetupAlerts.safeParse({ kind: 'nostr', recipient: invalid, relays: ['wss://relay.example'] }).success,
      ).toBe(false);
    }
    for (const relays of [
      [],
      ['ws://relay.example'],
      ['https://relay.example'],
      Array<string>(6).fill('wss://relay.example'),
    ])
      expect(SetupAlerts.safeParse({ kind: 'nostr', recipient, relays }).success).toBe(false);
  });
  it('validates explicit no alerts and Telegram tokens with strict fields', () => {
    expect(SetupAlerts.safeParse({ kind: 'none' }).success).toBe(true);
    expect(SetupAlerts.safeParse({ kind: 'none', botToken: 'extra' }).success).toBe(false);
    expect(SetupAlerts.safeParse({ kind: 'telegram', botToken: `123456:${'A'.repeat(35)}` }).success).toBe(true);
    for (const botToken of ['https://api.telegram.org', `12345:${'A'.repeat(35)}`, `123456:${'A'.repeat(34)}`])
      expect(SetupAlerts.safeParse({ kind: 'telegram', botToken }).success).toBe(false);
  });

  it('accepts independent action shapes while rejecting mixed fields and unproved backup', () => {
    for (const action of [
      { action: 'start', token: 'token' },
      { action: 'totp', code: '123456' },
      { action: 'recovery', code: 'saved-code' },
      { action: 'backup', confirmed: true },
      { action: 'node', node: null },
      { action: 'limits', limits },
      { action: 'alerts', alerts: { kind: 'none' } },
      { action: 'complete' },
      { action: 'cancel' },
    ]) {
      expect(SetupAction.safeParse(action).success).toBe(true);
    }
    for (const action of [
      { action: 'complete', password: 'extra' },
      { action: 'backup', confirmed: false },
      { action: 'totp', code: '12345' },
      { action: 'password', token: 'token', password: 'Password-123!' },
      { action: 'unknown' },
    ])
      expect(SetupAction.safeParse(action).success).toBe(false);
  });
  it('validates login factors without embedding authentication state in the schema', () => {
    for (const factors of [{ totpCode: '123456' }, { recoveryCode: 'saved-code' }])
      expect(LoginRequest.safeParse({ password: 'password', ...factors }).success).toBe(true);
    for (const fields of [
      { totpCode: '12345' },
      { totpCode: '１２３４５６' },
      { recoveryCode: '' },
      { unknown: 'extra' },
    ])
      expect(LoginRequest.safeParse({ password: 'password', ...fields }).success).toBe(false);
    expect(LoginRequest.safeParse({ password: '' }).success).toBe(false);
  });
});
