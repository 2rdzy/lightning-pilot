import { createRoute } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  AppError,
  EXPORT_REQUEST_BYTES,
  ErrorBody,
  ExportEnvelope,
  ExportRequest,
  ImportRequest,
  ImportResponse,
} from '@lightning-pilot/core';
import { sessionOf, type Router, type AppEnv } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import { createGuard, type AuthService } from '../auth/index.ts';
import type { ExportService } from './service.ts';
const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const errors = {
  400: { description: 'Invalid export', ...json(ErrorBody) },
  401: { description: 'Not authenticated', ...json(ErrorBody) },
  403: { description: 'Security step-up required', ...json(ErrorBody) },
  503: { description: 'Busy', ...json(ErrorBody) },
} as const;
export function exportRequestGuard(auth: AuthService, service: ExportService): MiddlewareHandler<AppEnv> {
  const tooLarge = () => {
    throw new AppError('body_too_large', 'The request body is too large.');
  };
  const ordinary = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
  const upload = bodyLimit({ maxSize: EXPORT_REQUEST_BYTES, onError: tooLarge });
  const manage = createGuard(auth)('manage');
  return async (c, next) => {
    if (c.req.method !== 'POST' || !['/api/v1/export', '/api/v1/export/import'].includes(c.req.path)) return next();
    return manage(c, async () => {
      await auth.requireStepUp(sessionOf(c).idHash, 'security');
      await service.run(async () => {
        const importing = c.req.path === '/api/v1/export/import';
        const limit = importing ? EXPORT_REQUEST_BYTES : 64 * 1024;
        const length = c.req.header('content-length');
        if (length !== undefined && Number(length) > limit) tooLarge();
        // Hono otherwise trusts Content-Length and skips counting actual stream bytes.
        // Keep its streaming cap even if the declared length is missing, malformed or under-reported.
        if (length !== undefined && c.req.raw.body) {
          const headers = new Headers(c.req.raw.headers);
          headers.delete('content-length');
          c.req.raw = new Request(c.req.raw, { headers });
        }
        await (importing ? upload : ordinary)(c, next);
      });
    });
  };
}
export function exportRoutes(app: Router, guard: Guard, service: ExportService): void {
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/export',
      request: { body: { required: true, ...json(ExportRequest) } },
      responses: { 200: { description: 'Encrypted export', ...json(ExportEnvelope) }, ...errors },
    }),
    async (c) => {
      const result = await service.export(sessionOf(c).idHash, c.req.valid('json'), c.get('requestId'));
      c.header(
        'Content-Disposition',
        `attachment; filename="lightning-pilot-export-${new Date().toISOString().slice(0, 10)}.json"`,
      );
      return c.json(result, 200);
    },
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/export/import',
      request: { body: { required: true, ...json(ImportRequest) } },
      responses: { 200: { description: 'Import committed', ...json(ImportResponse) }, ...errors },
    }),
    async (c) =>
      c.json(
        ImportResponse.parse(await service.import(sessionOf(c).idHash, c.req.valid('json'), c.get('requestId'))),
        200,
      ),
  );
}
