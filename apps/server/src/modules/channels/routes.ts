// Routes of the channels module. `channels/closed` is declared before `channels/{channel}` so the parameter route
// never sees the word "closed".
import { createRoute } from '@hono/zod-openapi';
import {
  ChannelPage,
  ChannelParam,
  ChannelResponse,
  ClosedChannelPage,
  ErrorBody,
  NodeIdParam,
  PageQuery,
} from '@lightning-pilot/core';
import type { Router } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import { pageRequest } from '../../http/paging.ts';
import type { ChannelsService } from './service.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const errors = {
  400: { description: 'Invalid request', ...json(ErrorBody) },
  401: { description: 'Not authenticated', ...json(ErrorBody) },
  403: { description: 'Permission denied', ...json(ErrorBody) },
  404: { description: 'No such node or channel', ...json(ErrorBody) },
  409: { description: 'Credential or capability problem', ...json(ErrorBody) },
  502: { description: 'The node did not answer as expected', ...json(ErrorBody) },
} as const;

export function channelsRoutes(app: Router, guard: Guard, channels: ChannelsService): void {
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/channels',
      summary: 'Channels of a node, in the node order',
      request: { params: NodeIdParam, query: PageQuery },
      responses: { 200: { description: 'Channels', ...json(ChannelPage) }, ...errors },
    }),
    async (c) =>
      c.json(
        ChannelPage.parse(await channels.list(c.req.valid('param').nodeId, pageRequest(c.req.valid('query')))),
        200,
      ),
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/channels/closed',
      summary: 'Closed channels of a node',
      request: { params: NodeIdParam, query: PageQuery },
      responses: { 200: { description: 'Closed channels', ...json(ClosedChannelPage) }, ...errors },
    }),
    async (c) =>
      c.json(
        ClosedChannelPage.parse(await channels.closed(c.req.valid('param').nodeId, pageRequest(c.req.valid('query')))),
        200,
      ),
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/channels/{channel}',
      summary: 'One channel, by short channel id, channel id or funding outpoint',
      request: { params: ChannelParam },
      responses: { 200: { description: 'Channel', ...json(ChannelResponse) }, ...errors },
    }),
    async (c) => {
      const { nodeId, channel } = c.req.valid('param');
      return c.json(ChannelResponse.parse(await channels.get(nodeId, channel)), 200);
    },
  );
}
