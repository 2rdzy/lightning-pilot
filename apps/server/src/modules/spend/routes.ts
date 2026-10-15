// Routes of the spend module: preview a payment, an on-chain send or a channel open or close, then execute it with
// the confirmation token; peer connection with the spend credential.
import { createRoute } from '@hono/zod-openapi';
import {
  SpendPolicy,
  SpendPolicyResponse,
  ErrorBody,
  IdempotencyHeader,
  NodeIdParam,
  PaymentExecuteRequest,
  PaymentPreviewRequest,
  PaymentPreviewResponse,
  PaymentResultResponse,
  ChannelClosePreviewRequest,
  ChannelClosePreviewResponse,
  ChannelOpenPreviewRequest,
  ChannelOpenPreviewResponse,
  OnchainPreviewRequest,
  OnchainPreviewResponse,
  PeerConnectRequest,
  PeerConnectResponse,
  PeerDisconnectRequest,
  PeerParam,
  SpendOutcomeResponse,
  SpendIntentParam,
  SpendResolveRequest,
  SpendResolveResponse,
  UnresolvedSpendsResponse,
} from '@lightning-pilot/core';
import { sessionOf, type Router } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import type { SpendService } from './service.ts';
import type { ChainSpendKind, ChainSpends } from './chain.ts';
import type { SpendResolution } from './resolve.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const errors = {
  400: { description: 'Invalid request', ...json(ErrorBody) },
  403: { description: 'Step-up or policy configuration required', ...json(ErrorBody) },
  401: { description: 'Not authenticated', ...json(ErrorBody) },
  404: { description: 'No such node', ...json(ErrorBody) },
  409: { description: 'Chain identity, confirmation or idempotency problem', ...json(ErrorBody) },
  422: { description: 'Payment failed; nothing was paid', ...json(ErrorBody) },
  502: { description: 'The node did not answer as expected', ...json(ErrorBody) },
} as const;

export function spendRoutes(
  app: Router,
  guard: Guard,
  spend: SpendService,
  chain: ChainSpends,
  resolution: SpendResolution,
): void {
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/spend-policy',
      summary: 'Lightning Pilot limits and rolling budget',
      request: { params: NodeIdParam },
      responses: { 200: { description: 'Policy and usage', ...json(SpendPolicyResponse) }, ...errors },
    }),
    async (c) => c.json(SpendPolicyResponse.parse(await spend.policy(c.req.valid('param').nodeId)), 200),
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes/{nodeId}/spend-policy',
      summary: 'Set limits with security step-up',
      request: { params: NodeIdParam, body: { required: true, ...json(SpendPolicy) } },
      responses: { 204: { description: 'Policy updated' }, ...errors },
    }),
    async (c) => {
      await spend.updatePolicy(
        sessionOf(c).handle,
        c.req.valid('param').nodeId,
        c.req.valid('json'),
        c.get('requestId'),
      );
      return c.body(null, 204);
    },
  );
  declare(
    app,
    guard,
    'spend',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes/{nodeId}/payments/preview',
      summary: 'Decode and check a payment request; returns the cost and a confirmation token',
      request: { params: NodeIdParam, body: { required: true, ...json(PaymentPreviewRequest) } },
      responses: { 200: { description: 'Preview', ...json(PaymentPreviewResponse) }, ...errors },
    }),
    async (c) => {
      const preview = await spend.preview(
        sessionOf(c).handle,
        c.req.valid('param').nodeId,
        c.req.valid('json').request,
        c.get('requestId'),
        c.req.valid('json'),
      );
      return c.json(PaymentPreviewResponse.parse(preview), 200);
    },
  );

  declare(
    app,
    guard,
    'spend',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes/{nodeId}/payments/execute',
      summary: 'Pay a previewed request (single-use confirmation token, idempotency key required)',
      request: {
        params: NodeIdParam,
        headers: IdempotencyHeader,
        body: { required: true, ...json(PaymentExecuteRequest) },
      },
      responses: { 200: { description: 'Outcome', ...json(PaymentResultResponse) }, ...errors },
    }),
    async (c) => {
      const result = await spend.execute(
        sessionOf(c).handle,
        c.req.valid('param').nodeId,
        c.req.valid('json').confirmationToken,
        c.req.valid('header')['idempotency-key'],
        c.get('requestId'),
        c.req.valid('json').acknowledgeDuplicate,
      );
      return c.json(PaymentResultResponse.parse(result), 200);
    },
  );

  chainSpendRoutes(app, guard, chain);
  resolutionRoutes(app, guard, resolution);
}

// Spends with no known outcome, and the owner's choice of outcome for one (security step-up).
function resolutionRoutes(app: Router, guard: Guard, resolution: SpendResolution): void {
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/spends/unresolved',
      summary: 'Spends whose outcome is unknown, oldest first, with the warning to show before resolving one',
      request: { params: NodeIdParam },
      responses: { 200: { description: 'Unresolved spends', ...json(UnresolvedSpendsResponse) }, ...errors },
    }),
    async (c) => c.json(UnresolvedSpendsResponse.parse(await resolution.list(c.req.valid('param').nodeId)), 200),
  );
  declare(
    app,
    guard,
    'spend',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes/{nodeId}/spends/{intentId}/resolve',
      summary: 'Set the outcome of an unresolved spend by hand (security step-up)',
      request: { params: SpendIntentParam, body: { required: true, ...json(SpendResolveRequest) } },
      responses: { 200: { description: 'Resolved', ...json(SpendResolveResponse) }, ...errors },
    }),
    async (c) => {
      const { nodeId, intentId } = c.req.valid('param');
      const resolved = await resolution.resolve(
        sessionOf(c).handle,
        nodeId,
        intentId,
        c.req.valid('json').outcome,
        c.get('requestId'),
      );
      return c.json(SpendResolveResponse.parse(resolved), 200);
    },
  );
}

function chainSpendRoutes(app: Router, guard: Guard, chain: ChainSpends): void {
  const previews = [
    {
      kind: 'onchain',
      path: 'onchain',
      summary: 'Check an on-chain send; returns the cost and a confirmation token',
      request: OnchainPreviewRequest,
      response: OnchainPreviewResponse,
    },
    {
      kind: 'channel-open',
      path: 'channels/open',
      summary: 'Check a channel open; returns the cost and a confirmation token',
      request: ChannelOpenPreviewRequest,
      response: ChannelOpenPreviewResponse,
    },
    {
      kind: 'channel-close',
      path: 'channels/close',
      summary:
        'Check a channel close (cooperative or forced, to the wallet or an address); returns a confirmation token',
      request: ChannelClosePreviewRequest,
      response: ChannelClosePreviewResponse,
    },
  ] as const;
  for (const route of previews) {
    declare(
      app,
      guard,
      'spend',
      createRoute({
        method: 'post',
        path: `/api/v1/nodes/{nodeId}/${route.path}/preview`,
        summary: route.summary,
        request: { params: NodeIdParam, body: { required: true, ...json(route.request) } },
        responses: { 200: { description: 'Preview', ...json(route.response) }, ...errors },
      }),
      async (c) => {
        const handle = sessionOf(c).handle;
        const nodeId = c.req.valid('param').nodeId;
        const body = c.req.valid('json') as never;
        const requestId = c.get('requestId');
        const preview =
          route.kind === 'onchain'
            ? await chain.previewOnchain(handle, nodeId, body, requestId)
            : route.kind === 'channel-open'
              ? await chain.previewChannelOpen(handle, nodeId, body, requestId)
              : await chain.previewChannelClose(handle, nodeId, body, requestId);
        return c.json(route.response.parse(preview), 200);
      },
    );
    declare(
      app,
      guard,
      'spend',
      createRoute({
        method: 'post',
        path: `/api/v1/nodes/{nodeId}/${route.path}/execute`,
        summary: 'Execute a previewed spend (single-use confirmation token, idempotency key required)',
        request: {
          params: NodeIdParam,
          headers: IdempotencyHeader,
          body: { required: true, ...json(PaymentExecuteRequest) },
        },
        responses: { 200: { description: 'Outcome', ...json(SpendOutcomeResponse) }, ...errors },
      }),
      async (c) => {
        const result = await chain.execute(
          route.kind as ChainSpendKind,
          sessionOf(c).handle,
          c.req.valid('param').nodeId,
          c.req.valid('json').confirmationToken,
          c.req.valid('header')['idempotency-key'],
          c.get('requestId'),
          c.req.valid('json').acknowledgeDuplicate,
        );
        return c.json(SpendOutcomeResponse.parse(result), 200);
      },
    );
  }
  declare(
    app,
    guard,
    'spend',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes/{nodeId}/peers',
      summary: 'Connect to a peer (spend credential)',
      request: { params: NodeIdParam, body: { required: true, ...json(PeerConnectRequest) } },
      responses: { 200: { description: 'Connected', ...json(PeerConnectResponse) }, ...errors },
    }),
    async (c) => {
      const connected = await chain.peer(
        sessionOf(c).handle,
        c.req.valid('param').nodeId,
        { connect: c.req.valid('json').uri },
        c.get('requestId'),
      );
      return c.json(PeerConnectResponse.parse(connected), 200);
    },
  );
  declare(
    app,
    guard,
    'spend',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes/{nodeId}/peers/{pubkey}/disconnect',
      summary: 'Disconnect a peer (spend credential)',
      request: { params: PeerParam, body: { required: true, ...json(PeerDisconnectRequest) } },
      responses: { 204: { description: 'Disconnected' }, ...errors },
    }),
    async (c) => {
      const { nodeId, pubkey } = c.req.valid('param');
      await chain.peer(
        sessionOf(c).handle,
        nodeId,
        { disconnect: pubkey, force: c.req.valid('json').force },
        c.get('requestId'),
      );
      return c.body(null, 204);
    },
  );
}
