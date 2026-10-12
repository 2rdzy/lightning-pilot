// Every route is registered through declare(), which attaches the permission it needs and records it. A route
// registered any other way has no recorded permission, and a test fails (default deny).
import type { RouteConfig, RouteHandler } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { Permission } from '@lightning-pilot/core';
import type { AppEnv, Router } from './context.ts';

export type Guard = (permission: Permission) => MiddlewareHandler<AppEnv>;

const registries = new WeakMap<object, Map<string, Permission>>();

export function declaredPermissions(app: Router): Map<string, Permission> {
  let registry = registries.get(app);
  if (!registry) {
    registry = new Map();
    registries.set(app, registry);
  }
  return registry;
}

// OpenAPI paths use {param}; Hono's route table uses :param.
const honoPath = (path: string) => path.replace(/\{([^}]+)\}/g, ':$1');

export function declare<R extends RouteConfig>(
  app: Router,
  guard: Guard,
  permission: Permission,
  route: R,
  handler: RouteHandler<R, AppEnv>,
): void {
  const key = `${route.method.toUpperCase()} ${honoPath(route.path)}`;
  const registry = declaredPermissions(app);
  if (registry.has(key)) throw new Error(`route declared twice: ${key}`);
  registry.set(key, permission);
  const guarded = { ...route, middleware: [guard(permission)], 'x-permission': permission } as R;
  app.openapi(guarded, handler);
}
