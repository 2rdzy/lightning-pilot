// Walking-skeleton shell: top bar with the node, its chain badge and block height; navigation on the left on a
// desktop and as a bottom tab bar on a phone (style guide §5). The full shell (Basic/Advanced, theme switch, live
// indicator, icons) is WP15.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ApiError } from '../api/client.ts';
import { formatInteger } from '../i18n/format.ts';
import { useApi } from './api-context.tsx';
import { useT } from './i18n.tsx';
import { ChainBadge, ErrorNote } from './parts.tsx';
import { nodeInfoQuery } from './queries.ts';
import { nodeRoute } from './router.tsx';
import { rememberNode } from './session.ts';

const NAV = [
  { to: '/n/$node', key: 'nav.dashboard', exact: true },
  { to: '/n/$node/pay', key: 'nav.pay', exact: false },
  { to: '/n/$node/receive', key: 'nav.receive', exact: false },
] as const;

export function Shell() {
  const tr = useT();
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { node, nodes } = nodeRoute.useLoaderData();
  const info = useQuery(nodeInfoQuery(api, node.id));
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    try {
      rememberNode(globalThis.localStorage, node.id);
    } catch {
      // Storage blocked: nothing to remember.
    }
  }, [node.id]);

  const leave = async () => {
    api.setCsrfToken(undefined);
    queryClient.clear();
    await navigate({ to: '/login', search: {} });
  };
  // The session ends when the server confirms it, or answers that it had already ended. After any other failure the
  // session cookie is still valid: the app stays as it is and says so, with a retry, rather than appear logged out.
  const logout = useMutation({
    mutationFn: () => api.call('logout'),
    onSuccess: leave,
    onError: async (err) => {
      if (err instanceof ApiError && err.code === 'unauthenticated') await leave();
    },
  });

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-bar md:bg-surface md:border-border flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-white md:border-b md:text-text">
        <span className="font-semibold">{tr.t('app.name')}</span>
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only md:not-sr-only">{tr.t('nav.node')}</span>
          <select
            className="rounded-control border-border bg-surface text-text border px-2 py-1"
            value={node.id}
            data-testid="node-select"
            onChange={(e) => {
              void navigate({ to: '/n/$node', params: { node: e.target.value } });
            }}
          >
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <ChainBadge identity={info.data?.chainIdentity ?? node.chainIdentity} />
        {info.data ? (
          <span className="text-sm tabular-nums" data-testid="block-height">
            {tr.t('dashboard.height')} {formatInteger(info.data.blockHeight, tr.locale)}
          </span>
        ) : null}
        <button
          type="button"
          className="ml-auto text-sm underline"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          {tr.t('nav.logout')}
        </button>
      </header>
      {logout.isError ? (
        <div className="px-4 pt-3">
          <p className="mb-2 text-sm">{tr.t('nav.logoutFailed')}</p>
          <ErrorNote error={logout.error} onRetry={() => logout.mutate()} />
        </div>
      ) : null}
      <p role="status" className="border-warning border p-3 text-sm">
        {tr.t('setup.noAlertsWarning')}
      </p>
      <div className="flex flex-1">
        <nav
          aria-label={tr.t('nav.main')}
          className="border-border bg-surface fixed inset-x-0 bottom-0 z-10 flex border-t md:static md:w-52 md:flex-col md:border-t-0 md:border-r md:py-4"
        >
          {NAV.map((item) => {
            const href = item.to.replace('$node', node.id);
            const active = item.exact ? pathname === href || pathname === `${href}/` : pathname.startsWith(href);
            return (
              <Link
                key={item.key}
                to={item.to}
                params={{ node: node.id }}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-11 flex-1 items-center justify-center px-4 text-sm md:flex-none md:justify-start ${
                  active ? 'text-brand-strong font-semibold' : 'text-text'
                }`}
              >
                {tr.t(item.key)}
              </Link>
            );
          })}
        </nav>
        <main className="w-full max-w-[1440px] flex-1 p-4 pb-20 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function NotFound() {
  const tr = useT();
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">{tr.t('app.notFound.title')}</h1>
      <p className="text-muted mb-4">{tr.t('app.notFound.body')}</p>
      <Link to="/" className="text-brand-strong underline">
        {tr.t('app.notFound.back')}
      </Link>
    </main>
  );
}

export function NoNodes() {
  const tr = useT();
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">{tr.t('app.noNodes.title')}</h1>
      <p className="text-muted">{tr.t('app.noNodes.body')}</p>
    </main>
  );
}
