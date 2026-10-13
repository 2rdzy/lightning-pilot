// Routes of the auth module: setup, login, logout, session; and the guard that enforces each route's permission.
import { timingSafeEqual } from 'node:crypto';
import { createRoute } from '@hono/zod-openapi';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  AppError,
  ErrorBody,
  LoginRequest,
  SessionResponse,
  RecoveryEnrollment,
  RecoveryConfirm,
  SetupStatusResponse,
  type Permission,
} from '@lightning-pilot/core';
import { sessionOf, type Router } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import { csrfTokenFor, type AuthService } from './service.ts';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Sent as __Host-lp_session: Secure, HttpOnly, SameSite=Strict, Path=/, no Domain.
export const SESSION_COOKIE = 'lp_session';

export const readSessionCookie = (c: Parameters<typeof getCookie>[0]) => getCookie(c, SESSION_COOKIE, 'host');

export function createGuard(auth: AuthService): Guard {
  return (permission: Permission) => async (c, next) => {
    if (permission === 'public') return next();
    if (permission === 'setup') {
      // Setup endpoints disappear once an owner exists.
      if (!auth.setupMode) throw new AppError('not_found', 'Not found.');
      return next();
    }
    if (auth.setupMode) throw new AppError('setup_required', 'Setup has not been completed.');
    const cookie = readSessionCookie(c);
    const session = cookie === undefined ? undefined : await auth.session(cookie);
    if (cookie === undefined || !session) throw new AppError('unauthenticated', 'Please log in.');
    if (permission === 'recovery' && !session.recoveryRequired)
      throw new AppError('step_up_required', 'A recovery login is required.');
    if (
      session.recoveryRequired &&
      permission !== 'recovery' &&
      !['/api/v1/auth/session', '/api/v1/auth/logout'].includes(c.req.path)
    )
      throw new AppError('permission_denied', 'Enrol a new authenticator before using the application.');
    const csrfToken = csrfTokenFor(cookie);
    // CSRF token on unsafe methods (SameSite=Strict is the first layer). Checked only once the cookie maps to a
    // live session: a stale cookie must never block login, or the owner would be stuck after an idle timeout.
    if (UNSAFE.has(c.req.method) && !sameText(c.req.header('x-csrf-token') ?? '', csrfToken)) {
      throw new AppError('csrf_failed', 'Missing or wrong CSRF token.');
    }
    // The owner holds every permission except `setup`; finer access levels come with API clients.
    c.set('session', {
      idHash: session.idHash,
      handle: session.handle,
      csrfToken,
      expiresAt: session.expiresAt,
      recoveryRequired: session.recoveryRequired,
    });
    return next();
  };
}

const errors = {
  400: { description: 'Invalid request', content: { 'application/json': { schema: ErrorBody } } },
  401: { description: 'Not authenticated', content: { 'application/json': { schema: ErrorBody } } },
  403: { description: 'Not allowed', content: { 'application/json': { schema: ErrorBody } } },
} as const;

export function authRoutes(app: Router, guard: Guard, auth: AuthService): void {
  declare(
    app,
    guard,
    'public',
    createRoute({
      method: 'get',
      path: '/api/v1/setup',
      summary: 'Whether setup is still required',
      responses: {
        200: { description: 'Setup status', content: { 'application/json': { schema: SetupStatusResponse } } },
      },
    }),
    (c) => c.json(SetupStatusResponse.parse({ setupRequired: auth.setupMode }), 200),
  );

  declare(
    app,
    guard,
    'public',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/login',
      summary: 'Log in with the owner password',
      request: { body: { required: true, content: { 'application/json': { schema: LoginRequest } } } },
      responses: {
        200: {
          description: 'Logged in; session cookie set',
          content: { 'application/json': { schema: SessionResponse } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const session = await auth.login(
        c.req.valid('json').password,
        c.get('requestId'),
        c.req.valid('json').totpCode,
        c.req.valid('json').recoveryCode,
      );
      setCookie(c, SESSION_COOKIE, session.cookieValue, {
        prefix: 'host',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/',
        expires: session.expiresAt,
      });
      return c.json(
        SessionResponse.parse({
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt.toISOString(),
          ...(session.recoveryRequired ? { recoveryRequired: true } : {}),
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
      path: '/api/v1/auth/session',
      summary: 'The current session and its CSRF token',
      responses: {
        200: { description: 'Session', content: { 'application/json': { schema: SessionResponse } } },
        ...errors,
      },
    }),
    async (c) => {
      const session = sessionOf(c);
      return c.json(
        SessionResponse.parse({
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt.toISOString(),
          ...(session.recoveryRequired ? { recoveryRequired: true } : {}),
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
      method: 'post',
      path: '/api/v1/auth/logout',
      summary: 'End the current session',
      responses: { 204: { description: 'Logged out' }, ...errors },
    }),
    async (c) => {
      await auth.logout(sessionOf(c).idHash, c.get('requestId'));
      deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
      c.header('Clear-Site-Data', '"cookies"');
      return c.body(null, 204);
    },
  );
  declare(
    app,
    guard,
    'recovery',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/totp/enrol',
      summary: 'Enrol after a recovery-code login',
      responses: {
        200: {
          description: 'New authenticator secret',
          content: { 'application/json': { schema: RecoveryEnrollment } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(RecoveryEnrollment.parse(await auth.beginRecovery(sessionOf(c).idHash)), 200),
  );
  declare(
    app,
    guard,
    'recovery',
    createRoute({
      method: 'post',
      path: '/api/v1/auth/totp/confirm',
      summary: 'Verify a recovered authenticator',
      request: { body: { required: true, content: { 'application/json': { schema: RecoveryConfirm } } } },
      responses: { 204: { description: 'Authenticator verified' }, ...errors },
    }),
    async (c) => {
      await auth.finishRecovery(sessionOf(c).idHash, c.req.valid('json').code, c.get('requestId'));
      return c.body(null, 204);
    },
  );
}
