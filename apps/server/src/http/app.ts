// The HTTP app. Every response gets the security headers (and no-store under /api). Every request passes, in order:
// Host allowlist (421) → Origin check on unsafe methods → body limit → the route's declared permission (with the
// CSRF token for live sessions) → validation.
// Errors always have one format: { error: { code, message, details?, requestId } }. With a web root, GET requests
// outside /api are answered with the web app's files (and its index.html for app routes, which use history routing).
import { eventsRoutes, type EventStreams } from '../modules/events/index.ts';
import { randomBytes } from 'node:crypto';
import { Http2ServerRequest } from 'node:http2';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { Context, MiddlewareHandler } from 'hono';
import { AdapterError, AppError, ERROR_STATUS, HealthResponse, type ErrorCode } from '@lightning-pilot/core';
import type { Logger } from '../logging/logger.ts';
import { nodeDetail } from '../logging/redact.ts';
import { setupRoutes, type SetupService } from '../modules/setup/index.ts';
import { authRoutes, createGuard, type AuthService } from '../modules/auth/index.ts';
import { sessionsRoutes } from '../modules/sessions/index.ts';
import { nodesRoutes, type NodesService } from '../modules/nodes/index.ts';
import { spendRoutes, type ChainSpends, type SpendResolution, type SpendService } from '../modules/spend/index.ts';
import type { AppEnv, Router } from './context.ts';
import { declare } from './declare.ts';

export interface AppDeps {
  streams: EventStreams;
  setup: SetupService;
  auth: AuthService;
  nodes: NodesService;
  spend: SpendService;
  chainSpends: ChainSpends;
  spendResolution: SpendResolution;
  logger: Logger;
  // Host allowlist (server.hosts).
  hosts: readonly string[];
  loginTransport?: 'direct' | 'tor';
  bodyLimitBytes?: number;
  // Directory of the built web app (apps/web/dist); without it the server answers the API only.
  webRoot?: string;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_BODY_LIMIT = 64 * 1024;

// The host name of a Host header or URL host, without port and IPv6 brackets, lower case.
function hostName(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
  return trimmed.replace(/:[0-9]+$/, '');
}

// The host the client asked for. HTTP/2 carries it in the :authority pseudo-header, which @hono/node-server does not
// copy into the request headers, so it is read from the Node request; HTTP/1.x has the Host header. Never taken from
// c.req.url: node-server fills that in with a default host name when the client sent none.
function requestHost(c: Context<AppEnv>): string | undefined {
  const incoming = (c.env as { incoming?: unknown } | undefined)?.incoming;
  if (incoming instanceof Http2ServerRequest) return incoming.authority || undefined;
  return c.req.header('host');
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

  // Security headers and the API's no-store go first, so every response has them, the refusals below included
  // (Hono turns an error into a response inside the middleware that threw it, so outer middleware still runs).
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

  // 1. Host allowlist: stops DNS rebinding; checked before routing, setup and login included.
  app.use(async (c, next) => {
    const host = requestHost(c);
    if (!host || !allowed.has(hostName(host))) throw new AppError('unknown_host', 'Unknown host.');
    c.set('host', host);
    await next();
  });

  // 2. Origin check on every unsafe method, whatever the content type: Origin must be this host over https (http
  // only for localhost and .onion), and Sec-Fetch-Site, when sent, must be same-origin.
  app.use(async (c, next) => {
    if (UNSAFE.has(c.req.method)) {
      const origin = c.req.header('origin');
      const host = c.get('host');
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

  // 3. Body limit.
  app.use(
    bodyLimit({
      maxSize: deps.bodyLimitBytes ?? DEFAULT_BODY_LIMIT,
      onError: () => {
        throw new AppError('body_too_large', 'The request body is too large.');
      },
    }),
  );

  if (deps.webRoot) app.use(webApp(deps.webRoot));

  app.onError((err, c) => {
    const requestId = c.get('requestId');
    if (err instanceof AppError) {
      if (
        (err.code === 'too_early' || err.code === 'busy') &&
        typeof err.details === 'object' &&
        err.details !== null &&
        'retryAfter' in err.details
      )
        c.header('Retry-After', String(err.details.retryAfter));
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
  eventsRoutes(app, guard, deps.streams);
  authRoutes(app, guard, deps.auth, deps.loginTransport ?? 'direct');
  setupRoutes(app, guard, deps.setup, deps.loginTransport ?? 'direct');
  sessionsRoutes(app, guard, deps.auth);
  nodesRoutes(app, guard, deps.nodes, deps.auth);
  spendRoutes(app, guard, deps.spend, deps.chainSpends, deps.spendResolution);
  return app;
}

// The built web app. Files under /assets have content hashes in their names and are cached for good; index.html
// is revalidated so a new release is picked up. A path without a file extension is an app route (history routing):
// it gets index.html and the router in the browser shows the screen or its "not found". Unknown files and every
// /api path fall through to the JSON 404.
function webApp(root: string): MiddlewareHandler<AppEnv> {
  const files = serveStatic<AppEnv>({ root });
  const appRoute = serveStatic<AppEnv>({ path: join(root, 'index.html') });
  return async (c, next) => {
    const path = c.req.path;
    if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || path.startsWith('/api/') || path === '/healthz') {
      return next();
    }
    const last = path.slice(path.lastIndexOf('/') + 1);
    const res = await (last.includes('.') ? files : appRoute)(c, next);
    if (res instanceof Response && res.ok) {
      res.headers.set(
        'Cache-Control',
        path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    }
    return res;
  };
}

export function openApiDocument(app: Router) {
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'Lightning Pilot API', version: '0.0.0' },
  });
}
