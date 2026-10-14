import { createRoute } from '@hono/zod-openapi';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  SessionPolicy,
  ErrorBody,
  StepUpRequest,
  StepUpResponse,
  SessionListResponse,
  SessionHandleParam,
  DeviceListResponse,
  DeviceHandleParam,
  PasswordChangeRequest,
  TotpChangeConfirm,
  TotpChangeEnrollment,
  RecoveryCountResponse,
  RecoveryCodesResponse,
} from '@lightning-pilot/core';
import { sessionOf, type Router } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import { SESSION_COOKIE, type AuthService } from '../auth/index.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const errors = {
  400: { description: 'Invalid request', ...json(ErrorBody) },
  401: { description: 'Not authenticated', ...json(ErrorBody) },
  403: { description: 'Re-authentication required or refused', ...json(ErrorBody) },
  429: { description: 'Wait before trying again', ...json(ErrorBody) },
  503: { description: 'Server busy', ...json(ErrorBody) },
} as const;

export function sessionsRoutes(app: Router, guard: Guard, auth: AuthService): void {
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'get',
      path: '/api/v1/auth/session-policy',
      responses: { 200: { description: 'Session timeouts', ...json(SessionPolicy) }, ...errors },
    }),
    async (c) => c.json(SessionPolicy.parse(await auth.sessions.policy(sessionOf(c).idHash)), 200),
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/session-policy',
      request: { body: { required: true, ...json(SessionPolicy) } },
      responses: { 204: { description: 'Session policy saved' }, ...errors },
    }),
    async (c) => {
      await auth.sessions.changePolicy(sessionOf(c).idHash, c.req.valid('json'));
      return c.body(null, 204);
    },
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/step-up',
      request: { body: { required: true, ...json(StepUpRequest) } },
      responses: { 200: { description: 'Re-authenticated; session rotated', ...json(StepUpResponse) }, ...errors },
    }),
    async (c) => {
      const input = c.req.valid('json');
      const result = await auth.stepUp(
        sessionOf(c).idHash,
        input.password,
        input.strength,
        input.totpCode,
        c.get('requestId'),
      );
      setCookie(c, SESSION_COOKIE, result.cookieValue, {
        prefix: 'host',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/',
        expires: result.expiresAt,
      });
      return c.json(
        StepUpResponse.parse({
          csrfToken: result.csrfToken,
          expiresAt: result.expiresAt.toISOString(),
          strength: result.strength,
          stepUpExpiresAt: result.stepUpExpiresAt.toISOString(),
        }),
        200,
      );
    },
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/auth/sessions',
      responses: { 200: { description: 'Live and ended sessions', ...json(SessionListResponse) }, ...errors },
    }),
    async (c) => c.json(SessionListResponse.parse(await auth.sessions.list(sessionOf(c).handle)), 200),
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/sessions/{sessionId}/revoke',
      request: { params: SessionHandleParam },
      responses: { 204: { description: 'Session ended' }, ...errors },
    }),
    async (c) => {
      const handle = c.req.valid('param').sessionId;
      await auth.sessions.end(handle, 'revoked');
      if (handle === sessionOf(c).handle) {
        deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
        c.header('Clear-Site-Data', '"cache", "storage"');
      }
      return c.body(null, 204);
    },
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/logout-everywhere',
      responses: { 204: { description: 'All sessions ended' }, ...errors },
    }),
    async (c) => {
      await auth.sessions.endAll('everywhere');
      deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
      c.header('Clear-Site-Data', '"cache", "storage"');
      return c.body(null, 204);
    },
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'get',
      path: '/api/v1/auth/devices',
      responses: { 200: { description: 'Known devices', ...json(DeviceListResponse) }, ...errors },
    }),
    async (c) => c.json(DeviceListResponse.parse(await auth.devices(sessionOf(c).idHash)), 200),
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/devices/{deviceId}/revoke',
      request: { params: DeviceHandleParam },
      responses: { 204: { description: 'Device identifier revoked; sessions unchanged' }, ...errors },
    }),
    async (c) => {
      await auth.revokeDevice(sessionOf(c).idHash, c.req.valid('param').deviceId, c.get('requestId'));
      return c.body(null, 204);
    },
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/password',
      request: { body: { required: true, ...json(PasswordChangeRequest) } },
      responses: { 204: { description: 'Password changed; other sessions ended' }, ...errors },
    }),
    async (c) => {
      await auth.changePassword(sessionOf(c).idHash, c.req.valid('json').password, c.get('requestId'));
      return c.body(null, 204);
    },
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/totp/change/enrol',
      responses: { 200: { description: 'Pending authenticator', ...json(TotpChangeEnrollment) }, ...errors },
    }),
    async (c) => c.json(TotpChangeEnrollment.parse(await auth.beginTotpChange(sessionOf(c).idHash)), 200),
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/totp/change/confirm',
      request: { body: { required: true, ...json(TotpChangeConfirm) } },
      responses: { 204: { description: 'Authenticator replaced; other sessions ended' }, ...errors },
    }),
    async (c) => {
      await auth.finishTotpChange(sessionOf(c).idHash, c.req.valid('json').code, c.get('requestId'));
      return c.body(null, 204);
    },
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'get',
      path: '/api/v1/auth/recovery-codes',
      responses: { 200: { description: 'Remaining recovery codes', ...json(RecoveryCountResponse) }, ...errors },
    }),
    async (c) => c.json(RecoveryCountResponse.parse(await auth.recoveryCount(sessionOf(c).idHash)), 200),
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/recovery-codes/regenerate',
      responses: { 200: { description: 'New codes, shown once', ...json(RecoveryCodesResponse) }, ...errors },
    }),
    async (c) =>
      c.json(
        RecoveryCodesResponse.parse(await auth.regenerateRecoveryCodes(sessionOf(c).idHash, c.get('requestId'))),
        200,
      ),
  );
}
