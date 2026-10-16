// The app shell (style guide §5). Desktop: a top bar with the node, its chain badge, the block height, the live
// indicator, the Basic/Advanced toggle, the theme and logout; a left navigation that collapses to icons. Phone: a
// top bar in --bar with the mark, the node and its chain badge, and a bottom tab bar Home · Channels · Pay ·
// Receive · More, where More holds the other screens, the view and theme switches and logout. A node on the wrong
// chain gets a full-width banner; a dropped live connection a quiet bar, never a dialog.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Button,
  cx,
  Icon,
  IconButton,
  LiveIndicator,
  Logo,
  MenuPanel,
  ReconnectingBar,
  SegmentedControl,
  useToast,
  WrongChainBanner,
  type LiveState,
} from '@lightning-pilot/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { useApi } from '../app/api-context.tsx';
import { useT } from '../app/i18n.tsx';
import { nodeInfoQuery } from '../app/queries.ts';
import { nodeRoute } from '../app/router.tsx';
import { rememberNode } from '../app/session.ts';
import { formatInteger } from '../i18n/format.ts';
import { connectLive } from './live.ts';
import { hrefOf, isActive, isAdvancedOnly, phoneLayout, visibleItems, type NavItem } from './navigation.ts';
import { ChainBadge, ErrorNote } from './parts.tsx';
import { storage, usePreferences } from './preferences-context.tsx';
import { THEME_CHOICES, VIEWS, type ThemeChoice, type View } from './preferences.ts';

type Translate = ReturnType<typeof useT>;

// Any navigation inside the app counts as user activity for the session's idle timer (sessions spec).
function useMarkActivity(): () => void {
  const api = useApi();
  return () => {
    void api.call('session', { userActivity: true }).catch(() => {});
  };
}

function ViewToggle({ tone }: { tone?: 'surface' | 'bar' }) {
  const tr = useT();
  const { view, setView } = usePreferences();
  return (
    <SegmentedControl<View>
      label={tr.t('view.label')}
      value={view}
      onChange={setView}
      options={VIEWS.map((v) => ({ value: v, label: tr.t(`view.${v}`) }))}
      testId="view-toggle"
      {...(tone ? { tone } : {})}
    />
  );
}

function ThemeSwitch() {
  const tr = useT();
  const { theme, setTheme } = usePreferences();
  return (
    <SegmentedControl<ThemeChoice>
      label={tr.t('theme.label')}
      value={theme}
      onChange={setTheme}
      options={THEME_CHOICES.map((t) => ({
        value: t,
        label: tr.t(`theme.${t}`),
        icon: <Icon name={t} size={16} />,
        iconOnly: true,
      }))}
      testId="theme-switch"
    />
  );
}

function NavLink({
  item,
  nodeId,
  pathname,
  tr,
  collapsed = false,
  label,
  className,
  onNavigate,
}: {
  item: NavItem;
  nodeId: string;
  pathname: string;
  tr: Translate;
  collapsed?: boolean;
  label?: string | undefined;
  className: string;
  onNavigate: () => void;
}) {
  const active = isActive(item, nodeId, pathname);
  const text = label ?? tr.t(item.label);
  return (
    <Link
      to={hrefOf(item, nodeId)}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? text : undefined}
      title={collapsed ? text : undefined}
      className={cx(className, active ? 'font-semibold text-brand-strong' : 'text-text')}
    >
      <Icon name={item.icon} size={20} />
      {collapsed ? null : <span>{text}</span>}
    </Link>
  );
}

export function Shell() {
  const tr = useT();
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const markActivity = useMarkActivity();
  const { view, isPhone } = usePreferences();
  const { node, nodes } = nodeRoute.useLoaderData();
  const info = useQuery(nodeInfoQuery(api, node.id));
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [live, setLive] = useState<LiveState>('connecting');
  // Bumped to open the live connection again after a logout the server did not confirm.
  const [liveRun, setLiveRun] = useState(0);
  const stopLive = useRef<() => void>(() => {});
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    rememberNode(storage(), node.id);
  }, [node.id]);

  useEffect(() => {
    // A new block or identity result changes the top bar: read the node again.
    const stop = connectLive({
      onState: setLive,
      eventTypes: ['block.new', 'chain_identity.updated'],
      onEvent: () => void queryClient.invalidateQueries({ queryKey: ['node'] }),
    });
    stopLive.current = stop;
    return stop;
  }, [liveRun, queryClient]);

  const leave = async () => {
    api.setCsrfToken(undefined);
    queryClient.clear();
    await navigate({ to: '/login', search: {} });
  };
  // The session ends when the server confirms it, or answers that it had already ended. After any other failure the
  // session cookie is still valid: the app stays as it is and says so, with a retry, rather than appear logged out.
  // The live stream closes first, so the server's end of the session does not make the browser reconnect.
  const logout = useMutation({
    mutationFn: () => {
      stopLive.current();
      return api.call('logout', { userActivity: true });
    },
    onSuccess: leave,
    onError: async (err) => {
      if (err instanceof ApiError && err.code === 'unauthenticated') return leave();
      setLiveRun((n) => n + 1);
    },
  });

  const copyLink = () => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) return;
    clipboard.writeText(globalThis.location.href).then(
      () => toast(tr.t('shell.linkCopied')),
      () => toast(tr.t('common.copyFailed'), globalThis.location.href),
    );
  };

  const identity = info.data?.chainIdentity ?? node.chainIdentity;
  const height = info.data ? (
    <span className="text-sm tabular-nums" data-testid="block-height">
      {tr.t('shell.height', { height: formatInteger(info.data.blockHeight, tr.locale) })}
    </span>
  ) : null;
  const liveIndicator = <LiveIndicator state={live} label={tr.t(`live.${live}`)} />;
  const nodeSelect = (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className={isPhone ? 'sr-only' : undefined}>{tr.t('nav.node')}</span>
      <select
        className="max-w-40 min-w-0 rounded-control border border-border bg-surface px-2 py-1 text-text"
        value={node.id}
        data-testid="node-select"
        onChange={(e) => {
          markActivity();
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
  );
  const logoutButton = (
    <Button
      variant="ghost"
      icon={<Icon name="logout" size={16} />}
      onClick={() => {
        setMoreOpen(false);
        logout.mutate();
      }}
      disabled={logout.isPending}
    >
      {tr.t('nav.logout')}
    </Button>
  );
  const { tabs, more } = phoneLayout(view);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-surface focus:p-2"
      >
        {tr.t('shell.skipToContent')}
      </a>
      {isPhone ? (
        <header className="sticky top-0 z-20 flex items-center gap-3 bg-bar px-4 py-2 text-white">
          <Logo size={28} label={tr.t('app.name')} />
          {nodeSelect}
          <span className="ml-auto">
            <ChainBadge identity={identity} />
          </span>
        </header>
      ) : (
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2">
          <Link to="/n/$node" params={{ node: node.id }} className="inline-flex items-center gap-2 font-semibold">
            <Logo size={28} />
            <span>{tr.t('app.name')}</span>
          </Link>
          {nodeSelect}
          <ChainBadge identity={identity} />
          {height}
          {liveIndicator}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <ViewToggle />
            <ThemeSwitch />
            <IconButton label={tr.t('shell.copyLink')} icon={<Icon name="link" size={20} />} onClick={copyLink} />
            {logoutButton}
          </span>
        </header>
      )}
      {identity.state === 'refused' ? <WrongChainBanner>{tr.t('chain.refusedBanner')}</WrongChainBanner> : null}
      {live === 'reconnecting' ? <ReconnectingBar>{tr.t('live.paused')}</ReconnectingBar> : null}
      {logout.isError ? (
        <div className="px-4 pt-3">
          <p className="mb-2 text-sm">{tr.t('nav.logoutFailed')}</p>
          <ErrorNote error={logout.error} onRetry={() => logout.mutate()} />
        </div>
      ) : null}
      <p role="status" className="border-b border-border bg-surface px-4 py-2 text-sm text-muted">
        {tr.t('setup.noAlertsWarning')}
      </p>
      <div className="flex flex-1">
        {isPhone ? null : (
          <nav
            aria-label={tr.t('nav.main')}
            className={cx(
              'sticky top-14 flex h-[calc(100dvh-3.5rem)] shrink-0 flex-col gap-1 border-r border-border bg-surface py-4',
              collapsed ? 'w-16 items-center' : 'w-56 px-2',
            )}
          >
            {visibleItems(view).map((item, index, list) => (
              <div
                key={item.id}
                className={
                  item.section === 'end' && list[index - 1]?.section !== 'end'
                    ? 'mt-auto border-t border-border pt-2'
                    : undefined
                }
              >
                <NavLink
                  item={item}
                  nodeId={node.id}
                  pathname={pathname}
                  tr={tr}
                  collapsed={collapsed}
                  onNavigate={markActivity}
                  className={cx(
                    'flex min-h-11 items-center gap-3 rounded-control text-sm hover:bg-bg',
                    collapsed ? 'w-11 justify-center' : 'px-3',
                  )}
                />
              </div>
            ))}
            <IconButton
              label={tr.t(collapsed ? 'nav.expand' : 'nav.collapse')}
              icon={<Icon name={collapsed ? 'expand' : 'collapse'} size={20} />}
              onClick={() => setCollapsed((c) => !c)}
              className={cx('text-muted', collapsed ? '' : 'self-end')}
            />
          </nav>
        )}
        <main id="main" className="w-full max-w-[1440px] min-w-0 flex-1 p-4 pb-24 md:p-8">
          {isAdvancedOnly(view, node.id, pathname) ? (
            <p className="mb-4 rounded-control border border-info px-3 py-2 text-sm" data-testid="advanced-only">
              {tr.t('view.advancedOnly')}
            </p>
          ) : null}
          <Outlet />
        </main>
      </div>
      {isPhone ? (
        <nav
          aria-label={tr.t('nav.main')}
          className="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-surface"
        >
          {tabs.map((item) => (
            <NavLink
              key={item.id}
              item={item}
              nodeId={node.id}
              pathname={pathname}
              tr={tr}
              label={item.id === 'dashboard' ? tr.t('nav.home') : undefined}
              onNavigate={markActivity}
              className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs"
            />
          ))}
          <MenuPanel
            open={moreOpen}
            onOpenChange={setMoreOpen}
            title={tr.t('nav.more')}
            triggerClassName="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs text-text"
            trigger={
              <>
                <Icon name="more" size={20} />
                <span>{tr.t('nav.more')}</span>
              </>
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              {height}
              {liveIndicator}
            </div>
            {more.length > 0 ? (
              <ul className="flex flex-col">
                {more.map((item) => (
                  <li key={item.id}>
                    <NavLink
                      item={item}
                      nodeId={node.id}
                      pathname={pathname}
                      tr={tr}
                      onNavigate={() => {
                        markActivity();
                        setMoreOpen(false);
                      }}
                      className="flex min-h-11 items-center gap-3 rounded-control px-2 text-sm hover:bg-bg"
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <ViewToggle />
              <ThemeSwitch />
            </div>
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              <Button variant="ghost" icon={<Icon name="link" size={16} />} onClick={copyLink}>
                {tr.t('shell.copyLink')}
              </Button>
              {logoutButton}
            </div>
          </MenuPanel>
        </nav>
      ) : null}
    </div>
  );
}
