// Chain badge, wrong-chain banner, status pills and the live indicator (style guide §2, §6). Colour never carries
// meaning alone: every state has its text, and the two chains have different icons in the same brand red.
import { CircleCheck, Clock, Hash, Hexagon, Radio, ShieldAlert, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export type ChainBadgeKind = 'blake2b' | 'bitcoin' | 'waiting' | 'refused';

const BADGE: Record<ChainBadgeKind, { tone: string; icon: ReactNode }> = {
  blake2b: { tone: 'bg-brand text-white', icon: <Hexagon size={14} /> },
  bitcoin: { tone: 'bg-brand text-white', icon: <Hash size={14} /> },
  waiting: { tone: 'border border-warning text-text', icon: <Clock size={14} /> },
  refused: { tone: 'bg-danger text-on-danger', icon: <ShieldAlert size={14} /> },
};

export function ChainBadge({
  kind,
  label,
  title,
  testId = 'chain-badge',
}: {
  kind: ChainBadgeKind;
  label: string;
  title?: string;
  testId?: string;
}) {
  const { tone, icon } = BADGE[kind];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-control px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        tone,
      )}
      data-testid={testId}
      data-chain={kind}
      title={title}
    >
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
      {label}
    </span>
  );
}

// Full-width banner when the node is on the wrong chain: spending is blocked and the page says so at once.
export function WrongChainBanner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-center gap-2 bg-danger px-4 py-2 text-sm font-medium text-on-danger">
      <ShieldAlert size={16} aria-hidden="true" />
      {children}
    </div>
  );
}

export type Tone = 'success' | 'warning' | 'danger' | 'muted' | 'info';

const PILL: Record<Tone, string> = {
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  danger: 'border-danger text-danger',
  muted: 'border-border text-muted',
  info: 'border-info text-info',
};

// A state with its colour and label; `title` carries the node's native name (e.g. CHANNELD_NORMAL) on hover.
export function StatusPill({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-control border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        PILL[tone],
      )}
      title={title}
      data-tone={tone}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

export type LiveState = 'connecting' | 'live' | 'reconnecting';

// The small live-connection indicator in the top bar. Reconnecting is quiet, never a blocking dialog.
export function LiveIndicator({ state, label }: { state: LiveState; label: string }) {
  const icon =
    state === 'live' ? <Radio size={14} /> : state === 'reconnecting' ? <WifiOff size={14} /> : <Clock size={14} />;
  return (
    <span
      className={cx('inline-flex items-center gap-1 text-xs', state === 'live' ? 'text-current' : 'opacity-80')}
      data-testid="live-indicator"
      data-state={state}
      role="status"
    >
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
      {label}
    </span>
  );
}

// A quiet bar under the top bar while the live connection is down.
export function ReconnectingBar({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-warning bg-surface px-4 py-1 text-xs text-text" data-testid="reconnecting">
      {children}
    </div>
  );
}

export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-success" role="status">
      <CircleCheck size={16} aria-hidden="true" />
      {children}
    </p>
  );
}
