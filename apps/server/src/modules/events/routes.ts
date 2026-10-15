import { createRoute, z } from '@hono/zod-openapi';
import { ErrorBody } from '@lightning-pilot/core';
import { declare, type Guard } from '../../http/declare.ts';
import { sessionOf, type Router } from '../../http/context.ts';
import { readSessionCookie } from '../auth/index.ts';
import { eventDocumentation } from './schemas.ts';
import type { EventStreams } from './streams.ts';

export function eventsRoutes(app: Router, guard: Guard, streams: EventStreams): void {
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/events',
      summary: 'Live advisory events; re-read data after reload',
      'x-event-schemas': eventDocumentation(),
      responses: {
        200: {
          description: 'Server-sent events; Last-Event-ID resumes retained history',
          content: { 'text/event-stream': { schema: z.string() } },
        },
        401: { description: 'Not authenticated', content: { 'application/json': { schema: ErrorBody } } },
        403: { description: 'Recovery required', content: { 'application/json': { schema: ErrorBody } } },
        503: { description: 'Stream limit reached', content: { 'application/json': { schema: ErrorBody } } },
      },
    }),
    async (c) => {
      c.header('Content-Type', 'text/event-stream; charset=utf-8');
      c.header('X-Accel-Buffering', 'no');
      // Hono dispatches HEAD through GET and discards the body without cancelling it.
      if (c.req.method === 'HEAD') return c.body(null);
      const session = sessionOf(c);
      const body = await streams.open(
        readSessionCookie(c) ?? '',
        session.handle,
        c.req.raw.signal,
        c.req.header('last-event-id'),
      );
      return c.body(body);
    },
  );
}
