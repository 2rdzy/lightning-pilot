// Typed API client. Requests are checked against the shared zod schemas before they are sent and responses after
// they arrive, so the screens only ever see data of the agreed shape. The CSRF token is kept in memory only (sessions
// spec): after a reload it is fetched again with GET /auth/session.
import { ErrorBody, type ErrorCode } from '@lightning-pilot/core';
import type { z } from 'zod';
import { ENDPOINTS, type Endpoint, type EndpointName } from './endpoints.ts';

export class ApiError extends Error {
  readonly code: ErrorCode | 'network' | 'bad_response';
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: unknown;

  constructor(code: ApiError['code'], message: string, status: number, requestId?: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

type BodyOf<E> =
  E extends Endpoint<infer B, z.ZodType | undefined> ? (B extends z.ZodType ? z.input<B> : undefined) : never;
type ResponseOf<E> =
  E extends Endpoint<z.ZodType | undefined, infer R> ? (R extends z.ZodType ? z.output<R> : undefined) : never;

export interface CallOptions<N extends EndpointName> {
  params?: Record<string, string>;
  // Query parameters (paged lists: cursor, limit); validated with the endpoint's query schema before sending.
  query?: Record<string, string | number | undefined>;
  body?: BodyOf<(typeof ENDPOINTS)[N]>;
  idempotencyKey?: string;
  // Set only by a click/tap handler, never by background queries or session probes.
  userActivity?: boolean;
  signal?: AbortSignal;
  // Browser-bound setup has its own CSRF token; it does not create an authenticated app session.
  setupCsrfToken?: string;
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  // Called when the server answers 401 unauthenticated while the app had a session: it has ended (idle or absolute
  // timeout, logout elsewhere), so the app goes back to the login screen.
  onUnauthenticated?: () => void;
}

export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/\{([a-zA-Z]+)\}/g, (_whole, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}

// The query string of a request: the values the endpoint's schema accepts, in a stable order; empty without any.
export function buildQuery(
  schema: z.ZodType | undefined,
  query: Record<string, string | number | undefined> | undefined,
): string {
  if (query === undefined) return '';
  if (!schema) throw new Error('this endpoint takes no query parameters');
  const parsed = schema.parse(query) as Record<string, string | number | undefined>;
  const search = new URLSearchParams();
  for (const key of Object.keys(parsed).sort()) {
    const value = parsed[key];
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// 16 to 128 characters of [A-Za-z0-9_-]: 24 random bytes in base64url give 32.
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export class ApiClient {
  #csrfToken: string | undefined;
  #recoveryRequired = false;
  // Counts session changes (logout, login): a 401 ends the session only if it answers a request sent under it.
  #generation = 0;
  readonly #fetch: typeof fetch;
  readonly #onUnauthenticated: (() => void) | undefined;

  constructor(options: ApiClientOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#onUnauthenticated = options.onUnauthenticated;
  }

  get hasSession(): boolean {
    return this.#csrfToken !== undefined;
  }

  get requiresRecovery(): boolean {
    return this.#recoveryRequired;
  }

  setCsrfToken(token: string | undefined, recoveryRequired = false): void {
    this.#recoveryRequired = token !== undefined && recoveryRequired;
    if (token !== this.#csrfToken) this.#generation++;
    this.#csrfToken = token;
  }

  async call<N extends EndpointName>(
    name: N,
    options: CallOptions<N> = {},
  ): Promise<ResponseOf<(typeof ENDPOINTS)[N]>> {
    const endpoint: Endpoint<z.ZodType | undefined, z.ZodType | undefined> = ENDPOINTS[name];
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.userActivity) headers['x-user-activity'] = '1';
    let body: string | undefined;
    if (endpoint.body) {
      body = JSON.stringify(endpoint.body.parse(options.body));
      headers['content-type'] = 'application/json';
    }
    if (endpoint.method !== 'GET' && (options.setupCsrfToken ?? this.#csrfToken))
      headers['x-csrf-token'] = options.setupCsrfToken ?? this.#csrfToken ?? '';
    if (endpoint.idempotent) {
      if (!options.idempotencyKey) throw new Error(`${name} needs an idempotency key`);
      headers['idempotency-key'] = options.idempotencyKey;
    }

    const generation = this.#generation;
    let res: Response;
    try {
      res = await this.#fetch(buildPath(endpoint.path, options.params) + buildQuery(endpoint.query, options.query), {
        method: endpoint.method,
        headers,
        credentials: 'same-origin',
        ...(body === undefined ? {} : { body }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError('network', 'The server could not be reached.', 0);
    }

    if (res.status !== endpoint.status) throw await this.#error(res, generation);
    if (!endpoint.response) return undefined as ResponseOf<(typeof ENDPOINTS)[N]>;
    const parsed = endpoint.response.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success)
      throw new ApiError('bad_response', 'The server sent a reply that could not be used.', res.status);
    if (
      name === 'stepUp' &&
      generation === this.#generation &&
      typeof parsed.data === 'object' &&
      parsed.data !== null &&
      'csrfToken' in parsed.data &&
      typeof parsed.data.csrfToken === 'string'
    )
      this.setCsrfToken(parsed.data.csrfToken);
    return parsed.data as ResponseOf<(typeof ENDPOINTS)[N]>;
  }

  async #error(res: Response, generation: number): Promise<ApiError> {
    const parsed = ErrorBody.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      return new ApiError('bad_response', 'The server sent a reply that could not be used.', res.status);
    }
    const { code, message, requestId, details } = parsed.data.error;
    // Only a session that existed can end: the probe after a reload (GET /auth/session without a token) answers
    // 401 too, and must not send the app to the login screen in a loop. A late answer to a request of an earlier
    // session must not end the current one.
    if (code === 'unauthenticated' && this.#csrfToken !== undefined && generation === this.#generation) {
      this.#csrfToken = undefined;
      this.#onUnauthenticated?.();
    }
    return new ApiError(code, message, res.status, requestId, details);
  }
}
