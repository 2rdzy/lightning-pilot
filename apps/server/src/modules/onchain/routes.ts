// Routes of the onchain module. On-chain sends (`POST …/onchain/preview|execute`) are the spend module's, and new
// addresses (`POST …/onchain/address`) the wallet module's.
import { createRoute } from '@hono/zod-openapi';
import {
  ErrorBody,
  FeeEstimatesResponse,
  NodeIdParam,
  OnchainTxPage,
  PageQuery,
  UtxoList,
} from '@lightning-pilot/core';
import type { Router } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import { pageRequest } from '../../http/paging.ts';
import type { OnchainService } from './service.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const errors = {
  400: { description: 'Invalid request', ...json(ErrorBody) },
  401: { description: 'Not authenticated', ...json(ErrorBody) },
  403: { description: 'Permission denied', ...json(ErrorBody) },
  404: { description: 'No such node', ...json(ErrorBody) },
  409: { description: 'Credential or capability problem', ...json(ErrorBody) },
  502: { description: 'The node did not answer as expected', ...json(ErrorBody) },
} as const;

export function onchainRoutes(app: Router, guard: Guard, onchain: OnchainService): void {
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/onchain/transactions',
      summary: 'On-chain wallet transactions, newest first',
      request: { params: NodeIdParam, query: PageQuery },
      responses: { 200: { description: 'Transactions', ...json(OnchainTxPage) }, ...errors },
    }),
    async (c) =>
      c.json(
        OnchainTxPage.parse(await onchain.transactions(c.req.valid('param').nodeId, pageRequest(c.req.valid('query')))),
        200,
      ),
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/onchain/utxos',
      summary: 'Coins of the on-chain wallet',
      request: { params: NodeIdParam },
      responses: { 200: { description: 'Coins', ...json(UtxoList) }, ...errors },
    }),
    async (c) => c.json(UtxoList.parse(await onchain.utxos(c.req.valid('param').nodeId)), 200),
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/fees',
      summary: "The node's on-chain fee estimates",
      request: { params: NodeIdParam },
      responses: { 200: { description: 'Fee estimates', ...json(FeeEstimatesResponse) }, ...errors },
    }),
    async (c) => c.json(FeeEstimatesResponse.parse(await onchain.fees(c.req.valid('param').nodeId)), 200),
  );
}
