// Small display parts shared by the walking-skeleton screens. The full design system (status pills, tables, dialogs,
// toasts, icons) comes with WP15; these follow the same style guide rules in the simplest form.
import { useState } from 'react';
import type { ChainIdentityResponse } from '@lightning-pilot/core';
import type { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { formatCost, formatExactSats, formatSats } from '../i18n/format.ts';
import { useT } from './i18n.tsx';

// An amount in sats from msat. A balance is rounded down, with the exact msat value on hover when it is not a whole
// sat; a cost (`cost`) is always shown exactly, so an amount to pay never looks smaller than it is.
export function Amount({ msat, testId, cost = false }: { msat: string; testId?: string; cost?: boolean }) {
  const tr = useT();
  const value = BigInt(msat);
  const exact = formatExactSats(value, tr.locale);
  return (
    <span
      className="tabular-nums"
      data-testid={testId}
      title={exact === undefined || cost ? undefined : tr.t('amount.exact', { amount: exact })}
    >
      {tr.t('amount.sat', { amount: cost ? formatCost(value, tr.locale) : formatSats(value, tr.locale) })}
    </span>
  );
}

type Identity = z.infer<typeof ChainIdentityResponse>;

// The chain is always on screen (style guide §2): the badge text names the chain; waiting and refused stand out.
export function ChainBadge({ identity }: { identity: Identity }) {
  const tr = useT();
  const text = identity.state === 'confirmed' ? tr.t(`chain.${identity.profile}`) : tr.t(`chain.${identity.state}`);
  const tone =
    identity.state === 'confirmed'
      ? 'bg-brand text-white'
      : identity.state === 'waiting'
        ? 'border border-warning text-text'
        : 'bg-danger text-on-danger';
  return (
    <span
      className={`inline-flex items-center rounded-control px-2 py-0.5 text-xs font-semibold ${tone}`}
      data-testid="chain-badge"
      title={tr.t('chain.label', { chain: text })}
    >
      {text}
    </span>
  );
}

// The translated text of an error code; the server's English message only when there is no translation.
export function errorText(tr: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiError) return tr.has(`errors.${error.code}`) ? tr.t(`errors.${error.code}`) : error.message;
  return tr.t('errors.internal');
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const tr = useT();
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div role="alert" className="rounded-card border border-danger bg-surface p-4 text-sm" data-testid="error">
      <p className="text-danger font-medium">{errorText(tr, error)}</p>
      {requestId ? (
        <p className="text-muted mt-1 font-mono text-xs">{tr.t('common.requestId', { requestId })}</p>
      ) : null}
      {onRetry ? (
        <button type="button" className="btn-secondary mt-3" onClick={onRetry}>
          {tr.t('common.retry')}
        </button>
      ) : null}
    </div>
  );
}

export function CopyButton({ value }: { value: string }) {
  const tr = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? tr.t('common.copied') : tr.t('common.copy')}
    </button>
  );
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-border bg-surface p-4">
      <h2 className="text-muted mb-3 text-xs font-semibold tracking-wide uppercase">{title}</h2>
      {children}
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-muted text-xs">{hint}</p> : null}
      {error ? (
        <p className="text-danger text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
