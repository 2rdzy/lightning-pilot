// Routes of the spend module: preview a payment, then execute it with the confirmation token.
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
} from '@lightning-pilot/core';
import { sessionOf, type Router } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import type { SpendService } from './service.ts';

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

export function spendRoutes(app: Router, guard: Guard, spend: SpendService): void {
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
}
