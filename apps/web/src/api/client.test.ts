import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, buildPath, newIdempotencyKey } from './client.ts';

const NODE = '0b6c4b8e-0000-4000-8000-000000000000';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(reply: (url: string, init: RequestInit) => Response | Promise<Response>, onUnauthenticated = vi.fn()) {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = new ApiClient({
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return reply(String(input), init);
    },
    onUnauthenticated,
  });
  return { api, calls, onUnauthenticated };
}

const header = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string>)[name];

describe('API client', () => {
  it('builds paths with encoded parameters and refuses missing ones', () => {
    expect(buildPath('/api/v1/nodes/{nodeId}/balances', { nodeId: NODE })).toBe(`/api/v1/nodes/${NODE}/balances`);
    expect(buildPath('/x/{id}', { id: 'a/b' })).toBe('/x/a%2Fb');
    expect(() => buildPath('/x/{id}')).toThrow('missing path parameter id');
  });

  it('makes idempotency keys the server accepts, new each time', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });

  it('parses a response with the shared schema', async () => {
    const { api, calls } = client(() => json(200, { setupRequired: true }));
    expect(await api.call('setupStatus')).toEqual({ setupRequired: true });
    expect(calls[0]?.url).toBe('/api/v1/setup');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.credentials).toBe('same-origin');
  });

  it('sends the CSRF token on unsafe methods only, and the body as JSON', async () => {
    const { api, calls } = client((url) =>
      url.endsWith('/invoices')
        ? json(201, {
            paymentHash: 'a'.repeat(64),
            bolt11: 'lnbcrt1',
            amount: '1000',
            description: '',
            status: 'unpaid',
            expiresAt: '2026-10-13T09:00:00.000Z',
          })
        : json(200, { items: [] }),
    );
    api.setCsrfToken('csrf-1');
    expect(api.hasSession).toBe(true);
    await api.call('nodes');
    await api.call('createInvoice', { params: { nodeId: NODE }, body: { amount: '1000' } });
    expect(header(calls[0]?.init, 'x-csrf-token')).toBeUndefined();
    expect(header(calls[1]?.init, 'x-csrf-token')).toBe('csrf-1');
    expect(header(calls[1]?.init, 'content-type')).toBe('application/json');
    // Defaults of the shared schema are applied before sending.
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ amount: '1000', description: '' });
  });

  it('refuses an invalid request before sending it', async () => {
    const { api, calls } = client(() => json(201, {}));
    await expect(api.call('createInvoice', { params: { nodeId: NODE }, body: { amount: '1.5' } })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('needs an idempotency key for a payment and sends it', async () => {
    const { api, calls } = client(() =>
      json(422, { error: { code: 'payment_failed', message: 'No route.', requestId: 'r-1' } }),
    );
    await expect(
      api.call('executePayment', { params: { nodeId: NODE }, body: { confirmationToken: 't' } }),
    ).rejects.toThrow('needs an idempotency key');
    const err = await api
      .call('executePayment', {
        params: { nodeId: NODE },
        body: { confirmationToken: 't' },
        idempotencyKey: 'k'.repeat(32),
      })
      .catch((e: unknown) => e);
    expect(header(calls[0]?.init, 'idempotency-key')).toBe('k'.repeat(32));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('payment_failed');
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).requestId).toBe('r-1');
  });

  it('returns nothing for empty replies', async () => {
    const { api } = client(() => new Response(null, { status: 204 }));
    expect(await api.call('logout')).toBeUndefined();
  });

  it('forgets the session and reports it on 401 unauthenticated', async () => {
    const { api, onUnauthenticated } = client(() =>
      json(401, { error: { code: 'unauthenticated', message: 'Please log in.', requestId: 'r-2' } }),
    );
    api.setCsrfToken('csrf-1');
    await expect(api.call('nodes')).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(api.hasSession).toBe(false);
    expect(onUnauthenticated).toHaveBeenCalledOnce();
    // Without a session (the probe after a reload), a 401 is an answer, not an ended session.
    await expect(api.call('session')).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });

  it('ignores a 401 for a request sent under an earlier session', async () => {
    let answer: (res: Response) => void = () => {};
    const { api, onUnauthenticated } = client(() => new Promise<Response>((resolve) => (answer = resolve)));
    api.setCsrfToken('csrf-old');
    const stale = api.call('nodes');
    // Logged out and in again while the request was on its way.
    api.setCsrfToken(undefined);
    api.setCsrfToken('csrf-new');
    answer(json(401, { error: { code: 'unauthenticated', message: 'Please log in.', requestId: 'r-3' } }));
    await expect(stale).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(api.hasSession).toBe(true);
    expect(onUnauthenticated).not.toHaveBeenCalled();
    // The same token set again (the probe after a reload) is the same session: its 401 still ends it.
    api.setCsrfToken('csrf-new');
    const current = api.call('nodes');
    api.setCsrfToken('csrf-new');
    answer(json(401, { error: { code: 'unauthenticated', message: 'Please log in.', requestId: 'r-4' } }));
    await expect(current).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(api.hasSession).toBe(false);
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });

  it('reports unusable replies and network failures with their own codes', async () => {
    await expect(client(() => json(200, { setupRequired: 'yes' })).api.call('setupStatus')).rejects.toMatchObject({
      code: 'bad_response',
    });
    await expect(client(() => new Response('<html>', { status: 502 })).api.call('setupStatus')).rejects.toMatchObject({
      code: 'bad_response',
      status: 502,
    });
    await expect(
      client(() => {
        throw new TypeError('fetch failed');
      }).api.call('setupStatus'),
    ).rejects.toMatchObject({ code: 'network', status: 0 });
    const abort = new DOMException('aborted', 'AbortError');
    await expect(
      client(() => {
        throw abort;
      }).api.call('setupStatus'),
    ).rejects.toBe(abort);
  });

  it('uses the global fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { setupRequired: false }));
    try {
      expect(await new ApiClient().call('setupStatus')).toEqual({ setupRequired: false });
    } finally {
      spy.mockRestore();
    }
  });
});
