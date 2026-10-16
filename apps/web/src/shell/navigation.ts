// The navigation (style guide §5, route map §7). Desktop: a left bar with every screen of the view. Phone: a tab bar
// Home · Channels · Pay · Receive · More, where More holds the rest. A screen appears only once its route exists:
// the screen work packages set `built` when they add the route, so nothing links to a page that is not there.
import type { IconName } from '@lightning-pilot/ui';
import type { View } from './preferences.ts';

export type NavIcon = Extract<
  IconName,
  'dashboard' | 'channels' | 'peers' | 'payments' | 'onchain' | 'node' | 'pay' | 'receive' | 'settings'
>;

export interface NavItem {
  id: string;
  // Message key of the label.
  label: string;
  // Path below /n/:node ('' is the dashboard), or an absolute app path for app-wide screens.
  path: string;
  scope: 'node' | 'app';
  icon: NavIcon;
  // Shown in the Basic view too; otherwise Advanced only (style guide §7 route map).
  basic: boolean;
  // A phone tab (in this order) rather than an entry under More.
  tab?: number;
  // Settings and the like go below a separator on the desktop.
  section: 'main' | 'end';
  built: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'dashboard',
    label: 'nav.dashboard',
    path: '',
    scope: 'node',
    icon: 'dashboard',
    basic: true,
    tab: 0,
    section: 'main',
    built: true,
  },
  {
    id: 'channels',
    label: 'nav.channels',
    path: '/channels',
    scope: 'node',
    icon: 'channels',
    basic: true,
    tab: 1,
    section: 'main',
    built: true,
  },
  {
    id: 'peers',
    label: 'nav.peers',
    path: '/peers',
    scope: 'node',
    icon: 'peers',
    basic: false,
    section: 'main',
    built: true,
  },
  {
    id: 'payments',
    label: 'nav.payments',
    path: '/payments',
    scope: 'node',
    icon: 'payments',
    basic: true,
    section: 'main',
    built: false,
  },
  {
    id: 'onchain',
    label: 'nav.onchain',
    path: '/onchain',
    scope: 'node',
    icon: 'onchain',
    basic: false,
    section: 'main',
    built: false,
  },
  {
    id: 'node',
    label: 'nav.nodeInfo',
    path: '/node',
    scope: 'node',
    icon: 'node',
    basic: false,
    section: 'main',
    built: true,
  },
  {
    id: 'pay',
    label: 'nav.pay',
    path: '/pay',
    scope: 'node',
    icon: 'pay',
    basic: true,
    tab: 2,
    section: 'main',
    built: true,
  },
  {
    id: 'receive',
    label: 'nav.receive',
    path: '/receive',
    scope: 'node',
    icon: 'receive',
    basic: true,
    tab: 3,
    section: 'main',
    built: true,
  },
  // The settings overview comes with WP20; until then the only settings screen is export and import.
  {
    id: 'settings',
    label: 'nav.settings',
    path: '/settings/export',
    scope: 'app',
    icon: 'settings',
    basic: true,
    section: 'end',
    built: true,
  },
];

export function visibleItems(view: View, items: readonly NavItem[] = NAV_ITEMS): NavItem[] {
  return items.filter((item) => item.built && (view === 'advanced' || item.basic));
}

// Phone: the tabs in their order, and everything else of the view for the More menu.
export function phoneLayout(view: View, items: readonly NavItem[] = NAV_ITEMS): { tabs: NavItem[]; more: NavItem[] } {
  const visible = visibleItems(view, items);
  const tabs = visible.filter((item) => item.tab !== undefined).sort((a, b) => (a.tab ?? 0) - (b.tab ?? 0));
  return { tabs, more: visible.filter((item) => item.tab === undefined) };
}

export function hrefOf(item: NavItem, nodeId: string): string {
  return item.scope === 'node' ? `/n/${nodeId}${item.path}` : item.path;
}

// The dashboard is active only on its own path; every other item also for the routes below it.
export function isActive(item: NavItem, nodeId: string, pathname: string): boolean {
  const href = hrefOf(item, nodeId);
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (item.id === 'dashboard') return path === href;
  return path === href || path.startsWith(`${href}/`);
}

// A screen of the Advanced view opened by URL in the Basic view is still shown, with a note saying where it belongs
// (style guide §7: the view never changes URLs). Unbuilt items count too, so the rule holds as screens arrive.
export function isAdvancedOnly(
  view: View,
  nodeId: string,
  pathname: string,
  items: readonly NavItem[] = NAV_ITEMS,
): boolean {
  return view === 'basic' && items.some((item) => !item.basic && isActive(item, nodeId, pathname));
}
