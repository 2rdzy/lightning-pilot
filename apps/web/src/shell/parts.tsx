// The design-system components bound to the app: translated labels from the message files and amounts formatted
// for the browser's region. Screens use these; @lightning-pilot/ui itself knows no messages and no region.
import type { ChainIdentityResponse } from '@lightning-pilot/core';
import {
  AmountText,
  ChainBadge as UiChainBadge,
  CopyButton as UiCopyButton,
  ErrorState,
  IdValue as UiIdValue,
  type ChainBadgeKind,
  type CopyLabels,
} from '@lightning-pilot/ui';
import type { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { useT } from '../app/i18n.tsx';
import { formatCost, formatExactSats, formatSats } from '../i18n/format.ts';

export { Card, Field } from '@lightning-pilot/ui';

// An amount in sats from msat. A balance is rounded down, with the exact msat value on hover when it is not a whole
// sat; a cost (`cost`) is always shown exactly, so an amount to pay never looks smaller than it is.
export function Amount({ msat, testId, cost = false }: { msat: string; testId?: string; cost?: boolean }) {
  const tr = useT();
  const value = BigInt(msat);
  const exact = formatExactSats(value, tr.locale);
  const text = tr.t('amount.sat', { amount: cost ? formatCost(value, tr.locale) : formatSats(value, tr.locale) });
  return (
    <AmountText
      text={text}
      testId={testId}
      title={exact === undefined || cost ? undefined : tr.t('amount.exact', { amount: exact })}
    />
  );
}

type Identity = z.infer<typeof ChainIdentityResponse>;

export function chainBadgeKind(identity: Identity): ChainBadgeKind {
  return identity.state === 'confirmed' ? identity.profile : identity.state;
}

// The chain is always on screen (style guide §2): the badge text names the chain; waiting and refused stand out.
export function ChainBadge({ identity }: { identity: Identity }) {
  const tr = useT();
  const text = identity.state === 'confirmed' ? tr.t(`chain.${identity.profile}`) : tr.t(`chain.${identity.state}`);
  return <UiChainBadge kind={chainBadgeKind(identity)} label={text} title={tr.t('chain.label', { chain: text })} />;
}

// The translated text of an error code; the server's English message only when there is no translation.
export function errorText(tr: ReturnType<typeof useT>, error: unknown): string {
  // A throttled request says how long to wait (the server's Retry-After, also in the error details).
  if (error instanceof ApiError && error.code === 'too_early') {
    const details = error.details as { retryAfter?: unknown } | undefined;
    if (typeof details?.retryAfter === 'number' && details.retryAfter > 0)
      return tr.plural('errors.too_early', details.retryAfter, { seconds: details.retryAfter });
  }
  if (error instanceof ApiError) return tr.has(`errors.${error.code}`) ? tr.t(`errors.${error.code}`) : error.message;
  return tr.t('errors.internal');
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const tr = useT();
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <ErrorState
      message={errorText(tr, error)}
      requestId={requestId ? tr.t('common.requestId', { requestId }) : undefined}
      retryLabel={tr.t('common.retry')}
      onRetry={onRetry}
    />
  );
}

export function useCopyLabels(): CopyLabels {
  const tr = useT();
  return { copy: tr.t('common.copy'), copied: tr.t('common.copied'), failed: tr.t('common.copyFailed') };
}

export function CopyButton({ value }: { value: string }) {
  return <UiCopyButton value={value} labels={useCopyLabels()} />;
}

export function IdValue({ value, full, testId }: { value: string; full?: boolean; testId?: string }) {
  return (
    <UiIdValue value={value} labels={useCopyLabels()} {...(full ? { full } : {})} {...(testId ? { testId } : {})} />
  );
}
