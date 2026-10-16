// Routes of the wallet module. `POST …/invoices` (create) is the nodes module's; payments are made through the
// spend module.
import { createRoute } from '@hono/zod-openapi';
import {
  ErrorBody,
  InvoicePage,
  InvoiceRecordResponse,
  NewAddressRequest,
  NewAddressResponse,
  NodeIdParam,
  PageQuery,
  PaymentHashParam,
  PaymentPage,
  PaymentRecordResponse,
  parsePaymentHash,
} from '@lightning-pilot/core';
import type { Router } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import { pageRequest } from '../../http/paging.ts';
import type { WalletService } from './service.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const errors = {
  400: { description: 'Invalid request', ...json(ErrorBody) },
  401: { description: 'Not authenticated', ...json(ErrorBody) },
  403: { description: 'Permission denied', ...json(ErrorBody) },
  404: { description: 'No such node or record', ...json(ErrorBody) },
  409: { description: 'Chain identity, credential or capability problem', ...json(ErrorBody) },
  502: { description: 'The node did not answer as expected', ...json(ErrorBody) },
} as const;

export function walletRoutes(app: Router, guard: Guard, wallet: WalletService): void {
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/payments',
      summary: 'Payments made by the node, oldest first',
      request: { params: NodeIdParam, query: PageQuery },
      responses: { 200: { description: 'Payments', ...json(PaymentPage) }, ...errors },
    }),
    async (c) =>
      c.json(
        PaymentPage.parse(await wallet.payments(c.req.valid('param').nodeId, pageRequest(c.req.valid('query')))),
        200,
      ),
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/payments/{paymentHash}',
      summary: "The node's record of one payment",
      request: { params: PaymentHashParam },
      responses: { 200: { description: 'Payment', ...json(PaymentRecordResponse) }, ...errors },
    }),
    async (c) => {
      const { nodeId, paymentHash } = c.req.valid('param');
      return c.json(PaymentRecordResponse.parse(await wallet.payment(nodeId, parsePaymentHash(paymentHash))), 200);
    },
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/invoices',
      summary: 'Invoices of the node, oldest first',
      request: { params: NodeIdParam, query: PageQuery },
      responses: { 200: { description: 'Invoices', ...json(InvoicePage) }, ...errors },
    }),
    async (c) =>
      c.json(
        InvoicePage.parse(await wallet.invoices(c.req.valid('param').nodeId, pageRequest(c.req.valid('query')))),
        200,
      ),
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/invoices/{paymentHash}',
      summary: 'One invoice of the node',
      request: { params: PaymentHashParam },
      responses: { 200: { description: 'Invoice', ...json(InvoiceRecordResponse) }, ...errors },
    }),
    async (c) => {
      const { nodeId, paymentHash } = c.req.valid('param');
      return c.json(InvoiceRecordResponse.parse(await wallet.invoice(nodeId, parsePaymentHash(paymentHash))), 200);
    },
  );
  declare(
    app,
    guard,
    'receive',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes/{nodeId}/onchain/address',
      summary: 'A new on-chain receive address (only while the chain identity is confirmed)',
      request: { params: NodeIdParam, body: { required: true, ...json(NewAddressRequest) } },
      responses: { 201: { description: 'Address', ...json(NewAddressResponse) }, ...errors },
    }),
    async (c) =>
      c.json(
        NewAddressResponse.parse(await wallet.newAddress(c.req.valid('param').nodeId, c.req.valid('json').type)),
        201,
      ),
  );
}
