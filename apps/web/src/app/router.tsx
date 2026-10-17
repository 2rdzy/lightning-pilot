// Routes (style guide §7): history routing, node-scoped paths /n/:node/..., search params validated, deep links
// never act by themselves. WP02 has the walking-skeleton screens; the full route map comes with the screen WPs.
import { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { z } from 'zod';
import type { ApiClient } from '../api/client.ts';
import { DashboardScreen } from '../features/dashboard/DashboardScreen.tsx';
import { ChannelsScreen } from '../features/channels/ChannelsScreen.tsx';
import { ChannelScreen } from '../features/channels/ChannelScreen.tsx';
import { OpenChannelScreen, CloseChannelScreen } from '../features/channels/ChannelActionScreen.tsx';
import { PeersScreen } from '../features/peers/PeersScreen.tsx';
import { PeerScreen } from '../features/peers/PeerScreen.tsx';
import { ConnectScreen } from '../features/peers/ConnectScreen.tsx';
import {
  ChannelRef,
  PubkeySchema,
  ListSearch,
  DetailSearch,
  OpenSearch,
  CloseSearch,
} from '../features/channels/data.ts';
import { NodeScreen } from '../features/node/NodeScreen.tsx';
import { RecoveryScreen } from '../features/login/RecoveryScreen.tsx';
import { LoginScreen } from '../features/login/LoginScreen.tsx';
import { PayScreen } from '../features/pay/PayScreen.tsx';
import { ReceiveScreen } from '../features/receive/ReceiveScreen.tsx';
import { PaymentsScreen } from '../features/payments/PaymentsScreen.tsx';
import { InvoiceScreen, PaymentScreen } from '../features/payments/DetailScreens.tsx';
import { PaymentHashSchema, PaymentsSearch } from '../features/payments/data.ts';
import { OnchainScreen, TransactionScreen } from '../features/onchain/OnchainScreen.tsx';
import { SendScreen } from '../features/onchain/SendScreen.tsx';
import { OnchainSearch, TxidSchema, sendSearch } from '../features/onchain/data.ts';
import { SetupScreen } from '../features/setup/SetupScreen.tsx';
import { ExportScreen } from '../features/export/ExportScreen.tsx';
import { SettingsScreen } from '../features/settings/SettingsScreen.tsx';
import { SecurityScreen } from '../features/settings/SecurityScreen.tsx';
import { SessionsScreen } from '../features/settings/SessionsScreen.tsx';
import { DisplayScreen } from '../features/settings/DisplayScreen.tsx';
import { NodesScreen } from '../features/settings/NodesScreen.tsx';
import { NodeSettingsScreen } from '../features/settings/NodeSettingsScreen.tsx';
import { LimitsScreen } from '../features/settings/LimitsScreen.tsx';
import { SpendsScreen } from '../features/settings/SpendsScreen.tsx';
import { spendsSearch } from '../features/settings/data.ts';
import { nodesQuery } from './queries.ts';
import { pickNode, safeNext, sessionState } from './session.ts';
import { NoNodes, NotFound } from '../shell/pages.tsx';
import { AppShell, Shell } from '../shell/Shell.tsx';

export interface RouterContext {
  api: ApiClient;
  queryClient: QueryClient;
}

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

const NodeParam = z.uuid();

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  beforeLoad: async ({ context }) => {
    const state = await sessionState(context.api);
    if (state === 'recovery') throw redirect({ to: '/recover' });
    if (state === 'session') throw redirect({ to: '/' });
    if (state === 'anonymous') throw redirect({ to: '/login', search: {} });
  },
  component: SetupScreen,
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { next?: string } => {
    const next = safeNext(search.next);
    return next === undefined ? {} : { next };
  },
  beforeLoad: async ({ context }) => {
    const state = await sessionState(context.api);
    if (state === 'setup') throw redirect({ to: '/setup' });
    if (state === 'recovery') throw redirect({ to: '/recover' });
    if (state === 'session') throw redirect({ to: '/' });
  },
  component: LoginScreen,
});

const recoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/recover',
  beforeLoad: async ({ context }) => {
    const state = await sessionState(context.api);
    if (state === 'setup') throw redirect({ to: '/setup' });
    if (state === 'anonymous') throw redirect({ to: '/login', search: {} });
    if (state === 'session') throw redirect({ to: '/' });
  },
  component: RecoveryScreen,
});

// Every route below needs a session; without one the app goes to the login screen and comes back afterwards.
const authRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'auth',
  beforeLoad: async ({ context, location }) => {
    const state = await sessionState(context.api);
    if (state === 'setup') throw redirect({ to: '/setup' });
    if (state === 'recovery') throw redirect({ to: '/recover' });
    if (state === 'anonymous') {
      const next = safeNext(location.href);
      throw redirect({ to: '/login', search: next === undefined || next === '/' ? {} : { next } });
    }
  },
  component: Outlet,
});

// App-wide settings (route map /settings/…) in the shell, with or without a node: the first node is added here.
export const settingsRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/settings',
  loader: async ({ context }) => {
    const { items } = await context.queryClient.ensureQueryData(nodesQuery(context.api));
    return { nodes: items };
  },
  component: AppShell,
  notFoundComponent: NotFound,
});

const settingsIndexRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/', component: SettingsScreen });
const securityRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'security', component: SecurityScreen });
const sessionsRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'sessions', component: SessionsScreen });
const displayRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'display', component: DisplayScreen });
const exportRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'export', component: ExportScreen });

export const settingsNodesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'nodes',
  // `?add=1` opens the add-node form (a dialog-like step with its own URL, style guide §7).
  validateSearch: (search: Record<string, unknown>): { add?: true } =>
    search.add === true || search.add === 1 || search.add === '1' ? { add: true } : {},
  component: NodesScreen,
});

const checkNodeParam = ({ params }: { params: { node: string } }) => {
  if (!NodeParam.safeParse(params.node).success) throw notFound();
};

export const settingsNodeRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'nodes/$node',
  beforeLoad: checkNodeParam,
  component: NodeSettingsScreen,
});

export const settingsLimitsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'nodes/$node/limits',
  beforeLoad: checkNodeParam,
  component: LimitsScreen,
});

export const settingsSpendsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'spends',
  validateSearch: spendsSearch,
  component: SpendsScreen,
});

const indexRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/',
  loader: async ({ context }) => {
    const { items } = await context.queryClient.ensureQueryData(nodesQuery(context.api));
    const node = pickNode(
      storage(),
      items.map((n) => n.id),
    );
    if (node) throw redirect({ to: '/n/$node', params: { node } });
  },
  component: NoNodes,
});

export const nodeRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/n/$node',
  loader: async ({ context, params }) => {
    if (!NodeParam.safeParse(params.node).success) throw notFound();
    const { items } = await context.queryClient.ensureQueryData(nodesQuery(context.api));
    const node = items.find((n) => n.id === params.node);
    if (!node) throw notFound();
    return { node, nodes: items };
  },
  component: Shell,
  notFoundComponent: NotFound,
});

export const dashboardRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: '/',
  component: DashboardScreen,
});

export const receiveRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'receive',
  // The invoice tab is the plain route; only the on-chain tab shows in the URL.
  validateSearch: (search: Record<string, unknown>): { tab?: 'onchain' } =>
    search.tab === 'onchain' ? { tab: 'onchain' } : {},
  component: ReceiveScreen,
});

export const paymentsRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'payments',
  validateSearch: (search) => PaymentsSearch.parse(search),
  component: PaymentsScreen,
});
export const paymentRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'payments/$hash',
  beforeLoad: ({ params }) => {
    if (!PaymentHashSchema.safeParse(params.hash).success) throw notFound();
  },
  component: PaymentScreen,
});
export const invoiceRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'invoices/$hash',
  beforeLoad: ({ params }) => {
    if (!PaymentHashSchema.safeParse(params.hash).success) throw notFound();
  },
  component: InvoiceScreen,
});

export const nodeInfoRoute = createRoute({ getParentRoute: () => nodeRoute, path: 'node', component: NodeScreen });

export const payRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'pay',
  // A link may prefill the request; it never pays by itself (style guide §7).
  validateSearch: (search: Record<string, unknown>): { request?: string } =>
    typeof search.request === 'string' && search.request.length <= 4096 ? { request: search.request } : {},
  component: PayScreen,
});

export const onchainRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'onchain',
  validateSearch: (search) => OnchainSearch.parse(search),
  component: OnchainScreen,
});
export const onchainSendRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'onchain/send',
  // A link may prefill the address and amount; it never sends by itself (style guide §7).
  validateSearch: (search: Record<string, unknown>) => sendSearch(search),
  component: SendScreen,
});
export const onchainTxRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'onchain/tx/$txid',
  beforeLoad: ({ params }) => {
    if (!TxidSchema.safeParse(params.txid).success) throw notFound();
  },
  component: TransactionScreen,
});

export const channelsRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'channels',
  validateSearch: (search) => ListSearch.parse(search),
  component: ChannelsScreen,
});
export const channelRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'channels/$channel',
  validateSearch: (search) => DetailSearch.parse(search),
  beforeLoad: ({ params }) => {
    if (!ChannelRef.safeParse(params.channel).success) throw notFound();
  },
  component: ChannelScreen,
});
export const openChannelRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'channels/open',
  validateSearch: (search) => OpenSearch.parse(search),
  component: OpenChannelScreen,
});
export const closeChannelRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'channels/$channel/close',
  validateSearch: (search) => CloseSearch.parse(search),
  beforeLoad: ({ params }) => {
    if (!ChannelRef.safeParse(params.channel).success) throw notFound();
  },
  component: CloseChannelScreen,
});
export const peersRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'peers',
  validateSearch: (search) => ListSearch.parse(search),
  component: PeersScreen,
});
export const peerRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'peers/$pubkey',
  validateSearch: (search) => ListSearch.parse(search),
  beforeLoad: ({ params }) => {
    if (!PubkeySchema.safeParse(params.pubkey).success) throw notFound();
  },
  component: PeerScreen,
});
export const connectPeerRoute = createRoute({
  getParentRoute: () => nodeRoute,
  path: 'peers/connect',
  validateSearch: (search) => OpenSearch.parse(search),
  component: ConnectScreen,
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  recoveryRoute,
  authRoute.addChildren([
    settingsRoute.addChildren([
      settingsIndexRoute,
      securityRoute,
      sessionsRoute,
      displayRoute,
      exportRoute,
      settingsNodesRoute,
      settingsNodeRoute,
      settingsLimitsRoute,
      settingsSpendsRoute,
    ]),
    indexRoute,
    nodeRoute.addChildren([
      dashboardRoute,
      nodeInfoRoute,
      receiveRoute,
      payRoute,
      paymentsRoute,
      paymentRoute,
      invoiceRoute,
      onchainRoute,
      onchainSendRoute,
      onchainTxRoute,
      channelsRoute,
      channelRoute,
      openChannelRoute,
      closeChannelRoute,
      peersRoute,
      peerRoute,
      connectPeerRoute,
    ]),
  ]),
]);

export function createAppRouter(context: RouterContext) {
  return createRouter({ routeTree, context, defaultPreload: false, scrollRestoration: true });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
