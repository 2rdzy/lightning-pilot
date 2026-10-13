// Types shared by the HTTP layer and the modules' routes.
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { AppError } from '@lightning-pilot/core';

export interface SessionInfo {
  idHash: string;
  recoveryRequired: boolean;
  // Internal id, stable for the life of the session; spend confirmations are bound to it.
  handle: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    // The Host header, or HTTP/2's :authority; set by the Host allowlist, so always one of the allowed hosts.
    host: string;
    session: SessionInfo | undefined;
  };
}

export type Router = OpenAPIHono<AppEnv>;

// The session the route guard found. Only routes whose permission needs a session call this; for them the guard
// has already refused requests without one, so the error here is a last line of defence.
export function sessionOf(c: Context<AppEnv>): SessionInfo {
  const session = c.get('session');
  if (!session) throw new AppError('unauthenticated', 'Please log in.');
  return session;
}
