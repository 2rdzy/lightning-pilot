// Where the app stands with the server: setup open, logged out, or logged in. The CSRF token lives only in the API
// client's memory; after a reload GET /auth/session gives it again (sessions spec).
import { ApiError, type ApiClient } from '../api/client.ts';

export type SessionState = 'setup' | 'anonymous' | 'session' | 'recovery';

export async function sessionState(api: ApiClient): Promise<SessionState> {
  if (api.hasSession) return api.requiresRecovery ? 'recovery' : 'session';
  const { setupRequired } = await api.call('setupStatus');
  if (setupRequired) return 'setup';
  try {
    const session = await api.call('session');
    api.setCsrfToken(session.csrfToken, session.recoveryRequired);
    return session.recoveryRequired ? 'recovery' : 'session';
  } catch (err) {
    if (err instanceof ApiError && err.code === 'unauthenticated') return 'anonymous';
    throw err;
  }
}

// After login the app returns to the requested route only if it is a path inside the app (no open redirect):
// one leading slash, no scheme, no "//" or "/\" that a browser would read as another host.
export function safeNext(next: unknown): string | undefined {
  if (typeof next !== 'string' || next.length > 2048) return undefined;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return undefined;
  // Control characters and backslashes have no place in an app path (browsers drop or rewrite them).
  if ([...next].some((ch) => ch < ' ' || ch === '\\')) return undefined;
  return next;
}

// The node last opened in this browser, so "/" goes back to it; stored per device, never needed for security.
const LAST_NODE = 'lp.lastNode';

export function rememberNode(storage: Pick<Storage, 'setItem'> | undefined, nodeId: string): void {
  try {
    storage?.setItem(LAST_NODE, nodeId);
  } catch {
    // Storage may be disabled; then "/" opens the first node.
  }
}

export function pickNode(
  storage: Pick<Storage, 'getItem'> | undefined,
  nodeIds: readonly string[],
): string | undefined {
  let last: string | null;
  try {
    last = storage?.getItem(LAST_NODE) ?? null;
  } catch {
    last = null;
  }
  return last !== null && nodeIds.includes(last) ? last : nodeIds[0];
}
