// Routes of the peers module. `POST …/peers` (connect) is the spend module's.
import { createRoute } from '@hono/zod-openapi';
import { ErrorBody, NodeIdParam, PeerList } from '@lightning-pilot/core';
import type { Router } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import type { PeersService } from './service.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const errors = {
  400: { description: 'Invalid request', ...json(ErrorBody) },
  401: { description: 'Not authenticated', ...json(ErrorBody) },
  403: { description: 'Permission denied', ...json(ErrorBody) },
  404: { description: 'No such node', ...json(ErrorBody) },
  409: { description: 'Credential or capability problem', ...json(ErrorBody) },
  502: { description: 'The node did not answer as expected', ...json(ErrorBody) },
} as const;

export function peersRoutes(app: Router, guard: Guard, peers: PeersService): void {
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/peers',
      summary: 'Peers of a node',
      request: { params: NodeIdParam },
      responses: { 200: { description: 'Peers', ...json(PeerList) }, ...errors },
    }),
    async (c) => c.json(PeerList.parse(await peers.list(c.req.valid('param').nodeId)), 200),
  );
}
