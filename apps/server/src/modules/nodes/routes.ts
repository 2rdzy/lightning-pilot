// Routes of the nodes module: add and list nodes, node info, balances, and invoices.
import { randomUUID } from 'node:crypto';
import { createRoute } from '@hono/zod-openapi';
import {
  ManageNodeRequest,
  ReplaceNodeRequest,
  NodeSetupCommandRequest,
  NodeSetupCommandResponse,
  NodeCredentialStatusResponse,
  BalancesResponse,
  CreateInvoiceRequest,
  ErrorBody,
  InvoiceResponse,
  msat,
  NodeIdParam,
  NodeInfoResponse,
  NodeDetailsResponse,
  NodeListResponse,
  NodeSummary,
  parseMsat,
  toMsatString,
  type Balances,
} from '@lightning-pilot/core';
import type { AuthService } from '../auth/index.ts';
import { sessionOf } from '../../http/context.ts';
import type { Router } from '../../http/context.ts';
import { declare, type Guard } from '../../http/declare.ts';
import { setupCommand } from './credentials.ts';
import type { NodesService } from './service.ts';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const errors = {
  400: { description: 'Invalid request', ...json(ErrorBody) },
  401: { description: 'Not authenticated', ...json(ErrorBody) },
  403: { description: 'Permission, step-up or limits required', ...json(ErrorBody) },
  503: { description: 'Node changed; retry', ...json(ErrorBody) },
  404: { description: 'No such node', ...json(ErrorBody) },
  409: { description: 'Chain identity or credential problem', ...json(ErrorBody) },
  502: { description: 'The node did not answer as expected', ...json(ErrorBody) },
} as const;

const balancesJson = (b: Balances) => ({
  onchain: {
    confirmed: toMsatString(b.onchain.confirmed),
    unconfirmed: toMsatString(b.onchain.unconfirmed),
    reserved: toMsatString(b.onchain.reserved),
  },
  lightning: {
    local: toMsatString(b.lightning.local),
    spendable: toMsatString(b.lightning.spendable),
    remote: toMsatString(b.lightning.remote),
    receivable: toMsatString(b.lightning.receivable),
  },
  pendingClose: toMsatString(b.pendingClose),
});

export function nodesRoutes(app: Router, guard: Guard, nodes: NodesService, auth: AuthService): void {
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes/{nodeId}/credentials/check',
      request: { params: NodeIdParam },
      responses: { 200: { description: 'Credentials rechecked', ...json(NodeCredentialStatusResponse) }, ...errors },
    }),
    async (c) => {
      await auth.requireStepUp(sessionOf(c).idHash, 'security');
      return c.json(
        NodeCredentialStatusResponse.parse(
          await nodes.recheckCredentials(c.req.valid('param').nodeId, c.get('requestId'), (db) =>
            auth.requireStepUp(sessionOf(c).idHash, 'security', db),
          ),
        ),
        200,
      );
    },
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes/setup-command',
      request: { body: { required: true, ...json(NodeSetupCommandRequest) } },
      responses: { 200: { description: 'Local setup command', ...json(NodeSetupCommandResponse) }, ...errors },
    }),
    async (c) =>
      c.json(
        {
          command: setupCommand(c.req.valid('json').accessLevel),
          instructions:
            'Requires lightning-cli and jq on the node host; qrencode optionally prints a terminal QR. Run locally, then paste the JSON block. Enter the clnrest HTTPS URL and pinned CA separately. Keep the block secret.',
        },
        200,
      ),
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'put',
      path: '/api/v1/nodes/{nodeId}',
      request: { params: NodeIdParam, body: { required: true, ...json(ReplaceNodeRequest) } },
      responses: { 200: { description: 'Node replaced', ...json(NodeSummary) }, ...errors },
    }),
    async (c) => {
      await auth.requireStepUp(sessionOf(c).idHash, 'security');
      const result = await nodes.replace(c.req.valid('param').nodeId, c.req.valid('json'), c.get('requestId'), (db) =>
        auth.requireStepUp(sessionOf(c).idHash, 'security', db),
      );
      return c.json(NodeSummary.parse(result), 200);
    },
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'delete',
      path: '/api/v1/nodes/{nodeId}',
      request: { params: NodeIdParam },
      responses: { 204: { description: 'Node removed' }, ...errors },
    }),
    async (c) => {
      await auth.requireStepUp(sessionOf(c).idHash, 'security');
      await nodes.remove(c.req.valid('param').nodeId, c.get('requestId'), (db) =>
        auth.requireStepUp(sessionOf(c).idHash, 'security', db),
      );
      return c.body(null, 204);
    },
  );
  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/credentials',
      request: { params: NodeIdParam },
      responses: { 200: { description: 'Credential status', ...json(NodeCredentialStatusResponse) }, ...errors },
    }),
    async (c) =>
      c.json(NodeCredentialStatusResponse.parse(await nodes.credentialStatus(c.req.valid('param').nodeId)), 200),
  );
  declare(
    app,
    guard,
    'manage',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes',
      summary: 'Add a Core Lightning node',
      request: { body: { required: true, ...json(ManageNodeRequest) } },
      responses: { 201: { description: 'Node added', ...json(NodeSummary) }, ...errors },
    }),
    async (c) => {
      await auth.requireStepUp(sessionOf(c).idHash, 'security');
      const summary = await nodes.add(
        c.req.valid('json'),
        c.get('requestId'),
        (db) => auth.requireStepUp(sessionOf(c).idHash, 'security', db),
        true,
      );
      return c.json(NodeSummary.parse(summary), 201);
    },
  );

  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes',
      summary: 'List the nodes',
      responses: { 200: { description: 'Nodes', ...json(NodeListResponse) }, ...errors },
    }),
    async (c) => c.json(NodeListResponse.parse({ items: await nodes.list() }), 200),
  );

  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}',
      summary: 'Live information from a node',
      request: { params: NodeIdParam },
      responses: { 200: { description: 'Node information', ...json(NodeInfoResponse) }, ...errors },
    }),
    async (c) => {
      const { row, adapter } = await nodes.adapter(c.req.valid('param').nodeId);
      const facts = await adapter.node.getInfo();
      return c.json(
        NodeInfoResponse.parse({
          id: row.id,
          pubkey: facts.pubkey,
          alias: facts.alias,
          color: facts.color,
          implementation: facts.implementation,
          version: facts.version,
          chain: row.chain,
          network: row.network,
          blockHeight: facts.blockHeight,
          synced: facts.synced,
          numPeers: facts.numPeers,
          numActiveChannels: facts.numActiveChannels,
          numPendingChannels: facts.numPendingChannels,
          numInactiveChannels: facts.numInactiveChannels,
          chainIdentity: nodes.identity(row),
        }),
        200,
      );
    },
  );

  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/info',
      summary: 'Node details: live information, announced addresses and what the credentials allow',
      request: { params: NodeIdParam },
      responses: { 200: { description: 'Node details', ...json(NodeDetailsResponse) }, ...errors },
    }),
    async (c) => {
      const { row, adapter } = await nodes.readAdapter(c.req.valid('param').nodeId, 'node', 'getInfo');
      const facts = await adapter.node.getInfo();
      return c.json(
        NodeDetailsResponse.parse({
          id: row.id,
          pubkey: facts.pubkey,
          alias: facts.alias,
          color: facts.color,
          implementation: facts.implementation,
          version: facts.version,
          chain: row.chain,
          network: row.network,
          blockHeight: facts.blockHeight,
          synced: facts.synced,
          numPeers: facts.numPeers,
          numActiveChannels: facts.numActiveChannels,
          numPendingChannels: facts.numPendingChannels,
          numInactiveChannels: facts.numInactiveChannels,
          chainIdentity: nodes.identity(row),
          features: facts.features,
          addresses: facts.addresses ?? [],
          accessLevel: row.access_level,
          capabilities: nodes.capabilities(row),
        }),
        200,
      );
    },
  );

  declare(
    app,
    guard,
    'read',
    createRoute({
      method: 'get',
      path: '/api/v1/nodes/{nodeId}/balances',
      summary: 'On-chain and Lightning balances of a node',
      request: { params: NodeIdParam },
      responses: { 200: { description: 'Balances', ...json(BalancesResponse) }, ...errors },
    }),
    async (c) => {
      const { adapter } = await nodes.adapter(c.req.valid('param').nodeId);
      return c.json(BalancesResponse.parse(balancesJson(await adapter.balance.getBalances())), 200);
    },
  );

  declare(
    app,
    guard,
    'receive',
    createRoute({
      method: 'post',
      path: '/api/v1/nodes/{nodeId}/invoices',
      summary: 'Create a BOLT11 invoice',
      request: { params: NodeIdParam, body: { required: true, ...json(CreateInvoiceRequest) } },
      responses: { 201: { description: 'Invoice', ...json(InvoiceResponse) }, ...errors },
    }),
    async (c) => {
      const { adapter } = await nodes.adapter(c.req.valid('param').nodeId);
      const body = c.req.valid('json');
      const invoice = await adapter.receive.createInvoice({
        amount: msat(parseMsat(body.amount)),
        description: body.description,
        label: `lp-${randomUUID()}`,
        ...(body.expirySeconds === undefined ? {} : { expirySeconds: body.expirySeconds }),
      });
      return c.json(
        InvoiceResponse.parse({
          paymentHash: invoice.paymentHash,
          bolt11: invoice.bolt11,
          ...(invoice.amount === undefined ? {} : { amount: toMsatString(invoice.amount) }),
          description: invoice.description,
          status: invoice.status,
          expiresAt: invoice.expiresAt,
        }),
        201,
      );
    },
  );
}
