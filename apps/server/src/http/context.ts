// Types shared by the HTTP layer and the modules' routes.
import type { OpenAPIHono } from '@hono/zod-openapi';

export interface SessionInfo {
  idHash: string;
  // Internal id, stable for the life of the session; spend confirmations are bound to it.
  handle: string;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    session: SessionInfo | undefined;
  };
}

export type Router = OpenAPIHono<AppEnv>;
