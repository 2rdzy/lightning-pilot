// Types shared by the HTTP layer and the modules' routes.
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { AppError } from '@lightning-pilot/core';
import type { LoginOrigin } from '../modules/auth/index.ts';

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

// node-server supplies this environment from the actual incoming socket for both HTTP versions. In-memory
// requests lack a peer and deliberately share a conservative counter; forwarded headers alone cannot replace it.
export function loginOriginOf(c: Context<AppEnv>, transport: 'direct' | 'tor'): LoginOrigin {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  const peerAddress = incoming?.socket?.remoteAddress;
  const forwardedFor = c.req.header('x-forwarded-for');
  return {
    transport,
    ...(peerAddress === undefined ? {} : { peerAddress }),
    ...(forwardedFor === undefined ? {} : { forwardedFor }),
  };
}
