// Empty, loading and error states (style guide §6): every list says what will appear and how to add the first item;
// loading shows skeleton rows; an error shows its translated message, the request id and a retry.
import { CircleAlert, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button.tsx';

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border bg-surface px-4 py-10 text-center"
      data-testid="empty-state"
    >
      <Inbox size={24} aria-hidden="true" className="text-muted" />
      <p className="font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

// Placeholder rows while data loads. Announced once through its label, not row by row.
export function SkeletonRows({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2" data-testid="loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className="skeleton h-10 rounded-control bg-border" />
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  requestId,
  retryLabel,
  onRetry,
  children,
}: {
  message: string;
  // Already translated, e.g. "Request id: r-123".
  requestId?: string | undefined;
  retryLabel?: string;
  onRetry?: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <div role="alert" className="rounded-card border border-danger bg-surface p-4 text-sm" data-testid="error">
      <p className="flex items-start gap-2 font-medium text-danger">
        <CircleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{message}</span>
      </p>
      {requestId ? <p className="mt-1 font-mono text-xs text-muted">{requestId}</p> : null}
      {children}
      {onRetry && retryLabel ? (
        <Button className="mt-3" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
