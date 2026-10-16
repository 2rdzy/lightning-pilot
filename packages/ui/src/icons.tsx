// The icons the app uses, by name (style guide §6: lucide-react only, 16/20/24 px, always with a text label or an
// aria-label next to them, so the icon itself is hidden from screen readers).
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bitcoin,
  ChevronsLeft,
  ChevronsRight,
  Ellipsis,
  LayoutDashboard,
  Link2,
  LogOut,
  Monitor,
  Moon,
  Network,
  ReceiptText,
  Server,
  Settings,
  Sun,
  Users,
  type LucideIcon,
} from 'lucide-react';

const ICONS = {
  dashboard: LayoutDashboard,
  channels: Network,
  peers: Users,
  payments: ReceiptText,
  onchain: Bitcoin,
  node: Server,
  pay: ArrowUpRight,
  receive: ArrowDownLeft,
  settings: Settings,
  more: Ellipsis,
  logout: LogOut,
  link: Link2,
  collapse: ChevronsLeft,
  expand: ChevronsRight,
  system: Monitor,
  light: Sun,
  dark: Moon,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20 }: { name: IconName; size?: 16 | 20 | 24 }) {
  const Glyph = ICONS[name];
  return <Glyph size={size} aria-hidden="true" />;
}
