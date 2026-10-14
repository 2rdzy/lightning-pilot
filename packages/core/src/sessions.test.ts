import { describe, expect, it } from 'vitest';
import {
  StepUpRequest,
  PasswordChangeRequest,
  SessionPolicy,
  SessionListResponse,
  DeviceListResponse,
} from './sessions.ts';

describe('session API contracts', () => {
  it('requires exactly the factors appropriate to the step-up strength and rejects unknown inputs', () => {
    expect(StepUpRequest.safeParse({ password: 'value', strength: 'security' }).success).toBe(false);
    expect(StepUpRequest.safeParse({ password: 'value', strength: 'password', totpCode: '123456' }).success).toBe(
      false,
    );
    expect(StepUpRequest.safeParse({ password: 'value', strength: 'security', totpCode: '123456' }).success).toBe(true);
    expect(StepUpRequest.safeParse({ password: 'value', strength: 'password' }).success).toBe(true);
    expect(StepUpRequest.safeParse({ password: 'value', strength: 'password', extra: true }).success).toBe(false);
    expect(StepUpRequest.safeParse({ password: 'x'.repeat(1025), strength: 'password' }).success).toBe(false);
  });
  it('retains password policy and bounds configurable session lifetimes', () => {
    expect(PasswordChangeRequest.safeParse({ password: 'weak' }).success).toBe(false);
    expect(SessionPolicy.safeParse({ idleSeconds: 60, absoluteSeconds: 60 }).success).toBe(true);
    expect(SessionPolicy.safeParse({ idleSeconds: 60, absoluteSeconds: 31536001 }).success).toBe(false);
    expect(SessionPolicy.safeParse({ idleSeconds: 61, absoluteSeconds: 60 }).success).toBe(false);
  });
  it('lists public handles and refuses accidental exposure of cookie hashes', () => {
    const item = {
      id: '0b6c4b8e-0000-4000-8000-000000000000',
      createdAt: '2026-10-14T08:00:00Z',
      lastUsedAt: '2026-10-14T08:00:00Z',
      expiresAt: '2026-10-14T09:00:00Z',
      source: 'setup',
    };
    expect(DeviceListResponse.safeParse({ items: [item] }).success).toBe(true);
    expect(DeviceListResponse.safeParse({ items: [{ ...item, id_hash: 'secret' }] }).success).toBe(false);
    expect(
      SessionListResponse.safeParse({ items: [{ ...item, current: true, endedAt: null, endReason: null }] }).success,
    ).toBe(true);
  });
});
