// The HTTP app. Every request passes, in order: Host allowlist (421) → Origin check on unsafe methods → body limit →
// security headers → the route's declared permission (with the CSRF token for live sessions) → validation.
// Errors always have one format: { error: { code, message, details?, requestId } }.
import { randomBytes } from 'node:crypto';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { Context } from 'hono';
import { AdapterError, AppError, ERROR_STATUS, HealthResponse, type ErrorCode } from '@lightning-pilot/core';
import type { Logger } from '../logging/logger.ts';
import { nodeDetail } from '../logging/redact.ts';
import { authRoutes, createGuard, type AuthService } from '../modules/auth/index.ts';
import { nodesRoutes, type NodesService } from '../modules/nodes/index.ts';
import { spendRoutes, type SpendService } from '../modules/spend/index.ts';
import type { AppEnv, Router } from './context.ts';
import { declare } from './declare.ts';

export interface AppDeps {
  auth: AuthService;
  nodes: NodesService;
  spend: SpendService;
  logger: Logger;
  // Host allowlist (server.hosts).
  hosts: readonly string[];
  bodyLimitBytes?: number;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_BODY_LIMIT = 64 * 1024;

// The host name of a Host header or URL host, without port and IPv6 brackets, lower case.
function hostName(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
  return trimmed.replace(/:[0-9]+$/, '');
}

function errorResponse(c: Context<AppEnv>, code: ErrorCode, message: string, details?: unknown) {
  const body = {
    error: { code, message, ...(details === undefined ? {} : { details }), requestId: c.get('requestId') ?? 'r-none' },
  };
  return c.json(body, ERROR_STATUS[code] as 400);
}

export function createApp(deps: AppDeps): Router {
  const log = deps.logger.child('http');
  const allowed = new Set(deps.hosts.map(hostName));
  const app: Router = new OpenAPIHono<AppEnv>({
    // Validation errors: say which field and why (zod's messages hold no secrets), never echo the value.
    defaultHook: (result) => {
      if (!result.success) {
        const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        throw new AppError('validation_failed', 'The request is not valid.', details);
      }
      return undefined;
    },
  });

  app.use(async (c, next) => {
    c.set('requestId', `r-${randomBytes(6).toString('hex')}`);
    c.set('session', undefined);
    await next();
  });

  // 1. Host allowlist: stops DNS rebinding; checked before routing, setup and login included.
  app.use(async (c, next) => {
    const host = c.req.header('host');
    if (!host || !allowed.has(hostName(host))) throw new AppError('unknown_host', 'Unknown host.');
    await next();
  });

  // 2. Origin check on every unsafe method, whatever the content type: Origin must be this host over https (http
  // only for localhost and .onion), and Sec-Fetch-Site, when sent, must be same-origin.
  app.use(async (c, next) => {
    if (UNSAFE.has(c.req.method)) {
      const origin = c.req.header('origin');
      const host = c.req.header('host') ?? '';
      let ok = false;
      if (origin) {
        try {
          const url = new URL(origin);
          const name = hostName(url.host);
          const plainAllowed = name === 'localhost' || name.endsWith('.onion');
          ok =
            url.host === host.toLowerCase() &&
            allowed.has(name) &&
            (url.protocol === 'https:' || (url.protocol === 'http:' && plainAllowed));
        } catch {
          ok = false;
        }
      }
      const site = c.req.header('sec-fetch-site');
      if (!ok || (site !== undefined && site !== 'same-origin')) {
        throw new AppError('bad_origin', 'Request origin not allowed.');
      }
    }
    await next();
  });

  // 3. Body limit, then security headers on every response.
  app.use(
    bodyLimit({
      maxSize: deps.bodyLimitBytes ?? DEFAULT_BODY_LIMIT,
      onError: () => {
        throw new AppError('body_too_large', 'The request body is too large.');
      },
    }),
  );
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: 'no-referrer',
      xFrameOptions: 'DENY',
      strictTransportSecurity: 'max-age=31536000',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
      crossOriginResourcePolicy: 'same-origin',
    }),
  );
  app.use(async (c, next) => {
    await next();
    // API responses hold private data: never cache them.
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId');
    if (err instanceof AppError) {
      if (err.status >= 500) log.error('request failed', { requestId, code: err.code });
      return errorResponse(c, err.code, err.message, err.details);
    }
    if (err instanceof AdapterError) {
      log.warn('node call failed', {
        requestId,
        code: err.code,
        sent: err.sent,
        nodeCode: err.nodeCode,
        detail: nodeDetail(err.detail),
      });
      const messages: Partial<Record<ErrorCode, string>> = {
        node_unreachable: 'The node could not be reached.',
        node_credential_revoked: 'The node refused the credential.',
        node_bad_response: 'The node sent a reply that could not be used.',
        permission_denied: 'The node credential does not allow this.',
      };
      return errorResponse(c, err.code, messages[err.code] ?? 'The node reported an error.');
    }
    if (err instanceof HTTPException && err.status === 400) {
      return errorResponse(c, 'validation_failed', 'The request is not valid.');
    }
    log.error('unexpected error', { requestId, err });
    return errorResponse(c, 'internal', 'Something went wrong.');
  });
  app.notFound((c) => errorResponse(c, 'not_found', 'Not found.'));

  const guard = createGuard(deps.auth);
  declare(
    app,
    guard,
    'public',
    createRoute({
      method: 'get',
      path: '/healthz',
      summary: 'Liveness',
      responses: { 200: { description: 'Alive', content: { 'application/json': { schema: HealthResponse } } } },
    }),
    (c) => c.json(HealthResponse.parse({ status: 'ok' }), 200),
  );
  authRoutes(app, guard, deps.auth);
  nodesRoutes(app, guard, deps.nodes);
  spendRoutes(app, guard, deps.spend);
  return app;
}

export function openApiDocument(app: Router) {
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'Lightning Pilot API', version: '0.0.0' },
  });
}
