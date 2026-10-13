import { describe, expect, it } from 'vitest';
import { ApiClient } from '../api/client.ts';
import { pickNode, rememberNode, safeNext, sessionState } from './session.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const unauthenticated = () =>
  json(401, { error: { code: 'unauthenticated', message: 'Please log in.', requestId: 'r-1' } });

function api(routes: Record<string, () => Response>) {
  return new ApiClient({
    fetch: async (input) => {
      const reply = routes[String(input)];
      if (!reply) throw new Error(`unexpected ${String(input)}`);
      return reply();
    },
  });
}

describe('session state', () => {
  it('is setup while setup is open', async () => {
    expect(await sessionState(api({ '/api/v1/setup': () => json(200, { setupRequired: true }) }))).toBe('setup');
  });

  it('restores the CSRF token after a reload', async () => {
    const client = api({
      '/api/v1/setup': () => json(200, { setupRequired: false }),
      '/api/v1/auth/session': () => json(200, { csrfToken: 'c', expiresAt: '2026-10-13T10:00:00.000Z' }),
    });
    expect(await sessionState(client)).toBe('session');
    expect(client.hasSession).toBe(true);
    // Known session: no request.
    expect(await sessionState(client)).toBe('session');
  });

  it('is anonymous without a session, and passes other errors on', async () => {
    const setupDone = () => json(200, { setupRequired: false });
    expect(await sessionState(api({ '/api/v1/setup': setupDone, '/api/v1/auth/session': unauthenticated }))).toBe(
      'anonymous',
    );
    const broken = api({
      '/api/v1/setup': setupDone,
      '/api/v1/auth/session': () => json(500, { error: { code: 'internal', message: 'x', requestId: 'r' } }),
    });
    await expect(sessionState(broken)).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('return path after login', () => {
  it('accepts paths inside the app only', () => {
    expect(safeNext('/n/abc/pay?request=x')).toBe('/n/abc/pay?request=x');
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'n/abc',
      '',
      undefined,
      5,
      '/a\nb',
    ]) {
      expect(safeNext(bad), String(bad)).toBeUndefined();
    }
    expect(safeNext('/' + 'a'.repeat(3000))).toBeUndefined();
  });
});

describe('last used node', () => {
  it('returns the remembered node if it still exists, else the first', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(pickNode(storage, ['a', 'b'])).toBe('a');
    rememberNode(storage, 'b');
    expect(pickNode(storage, ['a', 'b'])).toBe('b');
    expect(pickNode(storage, ['a'])).toBe('a');
    expect(pickNode(storage, [])).toBeUndefined();
    expect(pickNode(undefined, ['a'])).toBe('a');
  });

  it('works when storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => rememberNode(blocked, 'a')).not.toThrow();
    expect(pickNode(blocked, ['a', 'b'])).toBe('a');
  });
});
