import { createRoute } from '@hono/zod-openapi';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { ErrorBody, SetupAction, SetupProgress } from '@lightning-pilot/core';
import type { Router } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import { SESSION_COOKIE } from '../auth/index.ts';
import type { SetupService } from './service.ts';
const COOKIE = 'lp_setup';
export function setupRoutes(app: Router, guard: Guard, setup: SetupService): void {
  declare(
    app,
    guard,
    'setup',
    createRoute({
      method: 'post',
      path: '/api/v1/setup',
      summary: 'Advance the browser-bound first-run wizard',
      request: { body: { required: true, content: { 'application/json': { schema: SetupAction } } } },
      responses: {
        200: {
          description: 'Setup progress (secrets only at enrolment)',
          content: { 'application/json': { schema: SetupProgress } },
        },
        400: { description: 'Invalid step', content: { 'application/json': { schema: ErrorBody } } },
        401: { description: 'Invalid setup session', content: { 'application/json': { schema: ErrorBody } } },
        403: { description: 'CSRF refused', content: { 'application/json': { schema: ErrorBody } } },
        404: { description: 'Setup finished', content: { 'application/json': { schema: ErrorBody } } },
        429: { description: 'Try later', content: { 'application/json': { schema: ErrorBody } } },
        503: { description: 'Setup in progress', content: { 'application/json': { schema: ErrorBody } } },
      },
    }),
    async (c) => {
      const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
      const reply = await setup.act(
        c.req.valid('json'),
        getCookie(c, COOKIE, 'host'),
        c.req.header('x-csrf-token'),
        c.get('requestId'),
        incoming?.socket?.remoteAddress ?? 'local',
      );
      if (reply.cookie)
        setCookie(c, COOKIE, reply.cookie, {
          prefix: 'host',
          secure: true,
          httpOnly: true,
          sameSite: 'Strict',
          path: '/',
          expires: new Date(reply.progress.expiresAt),
        });
      if (reply.sessionCookie && reply.progress.session) {
        setCookie(c, SESSION_COOKIE, reply.sessionCookie, {
          prefix: 'host',
          secure: true,
          httpOnly: true,
          sameSite: 'Strict',
          path: '/',
          expires: new Date(reply.progress.session.expiresAt),
        });
        setCookie(c, 'lp_device', reply.deviceCookie ?? '', {
          prefix: 'host',
          secure: true,
          httpOnly: true,
          sameSite: 'Strict',
          path: '/',
          maxAge: 365 * 24 * 60 * 60,
        });
      }
      if (reply.progress.step === 'done' || reply.progress.step === 'cancelled')
        deleteCookie(c, COOKIE, { prefix: 'host', secure: true, path: '/' });
      return c.json(SetupProgress.parse(reply.progress), 200);
    },
  );
}
