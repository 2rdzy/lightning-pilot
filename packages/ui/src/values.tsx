// Values on screen (style guide §6): amounts with tabular figures, ids in mono shortened to 8…8 with a copy button,
// untrusted node aliases cut and always next to their pubkey, and the two-colour liquidity bar. The text comes in
// already formatted and translated: this package knows no messages and no region (the web app owns both).
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cx } from './cx.ts';
import { cutText, localShare, shortenId } from './helpers.ts';

// An amount: `text` is what is shown, `title` the exact value on hover, `spoken` what a screen reader reads ("25 000
// sats") when it differs from the text.
export function AmountText({
  text,
  title,
  spoken,
  testId,
  className,
}: {
  text: string;
  title?: string | undefined;
  spoken?: string | undefined;
  testId?: string | undefined;
  className?: string;
}) {
  return (
    <span className={cx('tabular-nums', className)} data-testid={testId} title={title} aria-label={spoken}>
      {text}
    </span>
  );
}

export interface CopyLabels {
  copy: string;
  copied: string;
  // Shown with the value selected when the clipboard refuses (no permission, or not a secure context).
  failed: string;
}

// Copies a value. A refused clipboard shows the value as selected text instead, so it can still be copied by hand.
export function CopyButton({
  value,
  labels,
  compact = false,
}: {
  value: string;
  labels: CopyLabels;
  compact?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) return setState('failed');
    clipboard.writeText(value).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };
  const label = state === 'copied' ? labels.copied : labels.copy;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={copy}
        aria-label={compact ? label : undefined}
        title={compact ? label : undefined}
        className={cx(
          'inline-flex min-h-11 items-center justify-center gap-2 rounded-control text-sm',
          compact ? 'min-w-11 text-muted hover:text-text' : 'border border-border bg-surface px-4 py-2 text-text',
        )}
      >
        <span aria-hidden="true" className="inline-flex">
          {state === 'copied' ? <Check size={16} /> : <Copy size={16} />}
        </span>
        {compact ? null : label}
      </button>
      {state === 'failed' ? (
        <span className="flex flex-col gap-1 text-xs text-muted">
          {labels.failed}
          <input
            readOnly
            value={value}
            aria-label={labels.failed}
            className="input font-mono text-xs"
            ref={(el) => el?.select()}
          />
        </span>
      ) : null}
    </span>
  );
}

// An id or key: mono, shortened, full value on hover and for screen readers, with a compact copy button.
export function IdValue({
  value,
  labels,
  full = false,
  testId,
}: {
  value: string;
  labels: CopyLabels;
  full?: boolean;
  testId?: string;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span
        className={cx('font-mono text-sm', full && 'break-all')}
        title={value}
        aria-label={full ? undefined : value}
        data-testid={testId}
      >
        {full ? value : shortenId(value)}
      </span>
      <CopyButton value={value} labels={labels} compact />
    </span>
  );
}

// A node alias is untrusted text from the network: rendered as text (never HTML), cut, with its pubkey beside it.
export function NodeAlias({ alias, pubkey, labels }: { alias: string; pubkey: string; labels: CopyLabels }) {
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-2">
      <span className="font-medium" title={alias}>
        {cutText(alias)}
      </span>
      <IdValue value={pubkey} labels={labels} />
    </span>
  );
}

// Local (--brand) against remote (--muted) balance, with the numbers either side. `label` describes the whole bar
// for screen readers ("Local 600 000 sat, remote 400 000 sat").
export function LiquidityBar({
  local,
  remote,
  localText,
  remoteText,
  label,
}: {
  local: bigint;
  remote: bigint;
  localText: string;
  remoteText: string;
  label: string;
}) {
  const share = localShare(local, remote);
  return (
    <div className="flex items-center gap-2 text-xs tabular-nums" role="img" aria-label={label}>
      <span className="min-w-0 text-right" aria-hidden="true">
        {localText}
      </span>
      <svg viewBox="0 0 1000 8" preserveAspectRatio="none" className="h-2 min-w-16 flex-1" aria-hidden="true">
        <rect width="1000" height="8" rx="4" className="fill-border" />
        {share === undefined ? null : (
          <>
            <rect x={share} width={1000 - share} height="8" className="fill-muted" />
            <rect width={share} height="8" className="fill-brand" />
          </>
        )}
      </svg>
      <span className="min-w-0" aria-hidden="true">
        {remoteText}
      </span>
    </div>
  );
}
