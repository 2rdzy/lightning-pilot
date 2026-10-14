import { z } from 'zod';
import { Password, SessionResponse } from './api.ts';

export const StepUpStrength = z.enum(['password', 'security']);
export type StepUpStrength = z.infer<typeof StepUpStrength>;
export const StepUpRequest = z
  .strictObject({
    password: z.string().min(1).max(1024),
    strength: StepUpStrength,
    totpCode: z
      .string()
      .regex(/^[0-9]{6}$/)
      .optional(),
  })
  .refine((value) => (value.strength === 'security' ? value.totpCode !== undefined : value.totpCode === undefined), {
    message: 'Security step-up requires TOTP; password step-up accepts only a password',
  })
  .meta({ id: 'StepUpRequest' });
export const StepUpResponse = SessionResponse.extend({
  strength: StepUpStrength,
  stepUpExpiresAt: z.iso.datetime(),
}).meta({ id: 'StepUpResponse' });
export const SessionHandleParam = z.strictObject({ sessionId: z.uuid() });
export const DeviceHandleParam = z.strictObject({ deviceId: z.uuid() });
export const SessionListResponse = z
  .strictObject({
    items: z.array(
      z.strictObject({
        id: z.uuid(),
        createdAt: z.iso.datetime(),
        lastUsedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        source: z.string().max(200),
        current: z.boolean(),
        endedAt: z.iso.datetime().nullable(),
        endReason: z.string().max(32).nullable(),
      }),
    ),
  })
  .meta({ id: 'SessionList' });
export const DeviceListResponse = z
  .strictObject({
    items: z.array(
      z.strictObject({
        id: z.uuid(),
        createdAt: z.iso.datetime(),
        lastUsedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        source: z.string().max(200),
      }),
    ),
  })
  .meta({ id: 'DeviceList' });
export const PasswordChangeRequest = z.strictObject({ password: Password }).meta({ id: 'PasswordChangeRequest' });
export const TotpChangeConfirm = z
  .strictObject({ code: z.string().regex(/^[0-9]{6}$/) })
  .meta({ id: 'TotpChangeConfirm' });
export const TotpChangeEnrollment = z
  .strictObject({ secret: z.string(), uri: z.string(), expiresAt: z.iso.datetime() })
  .meta({ id: 'TotpChangeEnrollment' });
export const RecoveryCountResponse = z
  .strictObject({ remaining: z.int().min(0).max(10) })
  .meta({ id: 'RecoveryCount' });
export const RecoveryCodesResponse = z
  .strictObject({ codes: z.array(z.string()).length(10) })
  .meta({ id: 'RecoveryCodes' });

export const SessionPolicy = z
  .strictObject({
    idleSeconds: z.int().min(60).max(604800),
    absoluteSeconds: z.int().min(60).max(31536000),
  })
  .refine((value) => value.idleSeconds <= value.absoluteSeconds, {
    message: 'Idle timeout cannot exceed absolute timeout',
  })
  .meta({ id: 'SessionPolicy' });
