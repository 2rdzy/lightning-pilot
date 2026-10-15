// The API routes the web app calls, with the request and response schemas of the shared contract
// (`@lightning-pilot/core` api.ts). A test in tools/ checks every entry against the server's OpenAPI document, so a
// route that moves or changes its success status fails CI instead of the browser.
import {
  ExportRequest,
  ExportEnvelope,
  ImportRequest,
  ImportResponse,
  SpendPolicy,
  SpendPolicyResponse,
  StepUpRequest,
  StepUpResponse,
  SessionListResponse,
  DeviceListResponse,
  PasswordChangeRequest,
  TotpChangeConfirm,
  TotpChangeEnrollment,
  RecoveryCountResponse,
  RecoveryCodesResponse,
  SessionPolicy,
  BalancesResponse,
  CreateInvoiceRequest,
  InvoiceResponse,
  LoginRequest,
  NodeInfoResponse,
  NodeListResponse,
  PaymentExecuteRequest,
  PaymentPreviewRequest,
  PaymentPreviewResponse,
  PaymentResultResponse,
  SessionResponse,
  SetupAction,
  SetupProgress,
  RecoveryEnrollment,
  RecoveryConfirm,
  SetupStatusResponse,
} from '@lightning-pilot/core';
import type { z } from 'zod';

export interface Endpoint<Body extends z.ZodType | undefined, Response extends z.ZodType | undefined> {
  method: 'GET' | 'POST';
  // OpenAPI form: path parameters as {name}.
  path: string;
  status: number;
  body: Body;
  // undefined: the route answers with an empty body.
  response: Response;
  // Spending routes need an Idempotency-Key header.
  idempotent?: true;
}

const endpoint = <B extends z.ZodType | undefined, R extends z.ZodType | undefined>(e: Endpoint<B, R>) => e;

export const ENDPOINTS = {
  exportData: endpoint({
    method: 'POST',
    path: '/api/v1/export',
    status: 200,
    body: ExportRequest,
    response: ExportEnvelope,
  }),
  importData: endpoint({
    method: 'POST',
    path: '/api/v1/export/import',
    status: 200,
    body: ImportRequest,
    response: ImportResponse,
  }),
  spendPolicy: endpoint({
    method: 'GET',
    path: '/api/v1/nodes/{nodeId}/spend-policy',
    status: 200,
    body: undefined,
    response: SpendPolicyResponse,
  }),
  updateSpendPolicy: endpoint({
    method: 'POST',
    path: '/api/v1/nodes/{nodeId}/spend-policy',
    status: 204,
    body: SpendPolicy,
    response: undefined,
  }),
  stepUp: endpoint({
    method: 'POST',
    path: '/api/v1/auth/step-up',
    status: 200,
    body: StepUpRequest,
    response: StepUpResponse,
  }),
  sessions: endpoint({
    method: 'GET',
    path: '/api/v1/auth/sessions',
    status: 200,
    body: undefined,
    response: SessionListResponse,
  }),
  revokeSession: endpoint({
    method: 'POST',
    path: '/api/v1/auth/sessions/{sessionId}/revoke',
    status: 204,
    body: undefined,
    response: undefined,
  }),
  logoutEverywhere: endpoint({
    method: 'POST',
    path: '/api/v1/auth/logout-everywhere',
    status: 204,
    body: undefined,
    response: undefined,
  }),
  devices: endpoint({
    method: 'GET',
    path: '/api/v1/auth/devices',
    status: 200,
    body: undefined,
    response: DeviceListResponse,
  }),
  revokeDevice: endpoint({
    method: 'POST',
    path: '/api/v1/auth/devices/{deviceId}/revoke',
    status: 204,
    body: undefined,
    response: undefined,
  }),
  changePassword: endpoint({
    method: 'POST',
    path: '/api/v1/auth/password',
    status: 204,
    body: PasswordChangeRequest,
    response: undefined,
  }),
  changeTotpEnrol: endpoint({
    method: 'POST',
    path: '/api/v1/auth/totp/change/enrol',
    status: 200,
    body: undefined,
    response: TotpChangeEnrollment,
  }),
  changeTotpConfirm: endpoint({
    method: 'POST',
    path: '/api/v1/auth/totp/change/confirm',
    status: 204,
    body: TotpChangeConfirm,
    response: undefined,
  }),
  recoveryCount: endpoint({
    method: 'GET',
    path: '/api/v1/auth/recovery-codes',
    status: 200,
    body: undefined,
    response: RecoveryCountResponse,
  }),
  regenerateRecoveryCodes: endpoint({
    method: 'POST',
    path: '/api/v1/auth/recovery-codes/regenerate',
    status: 200,
    body: undefined,
    response: RecoveryCodesResponse,
  }),
  sessionPolicy: endpoint({
    method: 'GET',
    path: '/api/v1/auth/session-policy',
    status: 200,
    body: undefined,
    response: SessionPolicy,
  }),
  changeSessionPolicy: endpoint({
    method: 'POST',
    path: '/api/v1/auth/session-policy',
    status: 204,
    body: SessionPolicy,
    response: undefined,
  }),
  recoveryEnrol: endpoint({
    method: 'POST',
    path: '/api/v1/auth/totp/enrol',
    status: 200,
    body: undefined,
    response: RecoveryEnrollment,
  }),
  recoveryConfirm: endpoint({
    method: 'POST',
    path: '/api/v1/auth/totp/confirm',
    status: 204,
    body: RecoveryConfirm,
    response: undefined,
  }),
  setupStatus: endpoint({
    method: 'GET',
    path: '/api/v1/setup',
    status: 200,
    body: undefined,
    response: SetupStatusResponse,
  }),
  setup: endpoint({ method: 'POST', path: '/api/v1/setup', status: 200, body: SetupAction, response: SetupProgress }),
  login: endpoint({
    method: 'POST',
    path: '/api/v1/auth/login',
    status: 200,
    body: LoginRequest,
    response: SessionResponse,
  }),
  session: endpoint({
    method: 'GET',
    path: '/api/v1/auth/session',
    status: 200,
    body: undefined,
    response: SessionResponse,
  }),
  logout: endpoint({ method: 'POST', path: '/api/v1/auth/logout', status: 204, body: undefined, response: undefined }),
  nodes: endpoint({ method: 'GET', path: '/api/v1/nodes', status: 200, body: undefined, response: NodeListResponse }),
  node: endpoint({
    method: 'GET',
    path: '/api/v1/nodes/{nodeId}',
    status: 200,
    body: undefined,
    response: NodeInfoResponse,
  }),
  balances: endpoint({
    method: 'GET',
    path: '/api/v1/nodes/{nodeId}/balances',
    status: 200,
    body: undefined,
    response: BalancesResponse,
  }),
  createInvoice: endpoint({
    method: 'POST',
    path: '/api/v1/nodes/{nodeId}/invoices',
    status: 201,
    body: CreateInvoiceRequest,
    response: InvoiceResponse,
  }),
  previewPayment: endpoint({
    method: 'POST',
    path: '/api/v1/nodes/{nodeId}/payments/preview',
    status: 200,
    body: PaymentPreviewRequest,
    response: PaymentPreviewResponse,
  }),
  executePayment: endpoint({
    method: 'POST',
    path: '/api/v1/nodes/{nodeId}/payments/execute',
    status: 200,
    body: PaymentExecuteRequest,
    response: PaymentResultResponse,
    idempotent: true,
  }),
} as const;

export type EndpointName = keyof typeof ENDPOINTS;
