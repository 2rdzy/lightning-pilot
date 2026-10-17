// Settings › Unresolved spends (/settings/spends, both views; spend policy §13, §14): spends whose outcome the node
// has not confirmed, oldest first per node, and the owner's choice of outcome for one. Lightning Pilot keeps
// asking the node and settles them by itself when it can; marking one by hand needs a security step-up, and the
// server's warning is shown before the choice. `?node=` narrows the list to one node.
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UnresolvedSpend } from '@lightning-pilot/core';
import { Button, Card, DestructiveConfirm, EmptyState, SuccessNote } from '@lightning-pilot/ui';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import { ApiError } from '../../api/client.ts';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodesQuery } from '../../app/queries.ts';
import { settingsSpendsRoute } from '../../app/router.tsx';
import { formatDateTime } from '../../i18n/format.ts';
import { Amount, ChainBadge, ErrorNote, IdValue } from '../../shell/parts.tsx';
import { reasonOf, type NodeRow } from './data.ts';
import { SettingsPage } from './parts.tsx';
import { unresolvedQuery } from './queries.ts';
import { useSecurityGuard } from './step-up.tsx';

type Spend = z.infer<typeof UnresolvedSpend>;
type Outcome = 'succeeded' | 'failed';

function SpendRow({ spend, onResolve }: { spend: Spend; onResolve: (outcome: Outcome) => void }) {
  const tr = useT();
  const ids: [string, string | undefined][] = [
    ['settings.spends.destination', spend.destination],
    ['settings.spends.paymentHash', spend.paymentHash],
    ['settings.spends.txid', spend.txid],
    ['settings.spends.channel', spend.channelId],
    ['settings.spends.peer', spend.peer],
  ];
  return (
    <li className="flex flex-col gap-2 py-3" data-testid="unresolved-spend">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-medium">{tr.t(`settings.spends.type.${spend.type}`)}</span>
        <span className="text-sm">
          {tr.t('settings.spends.amount')} <Amount msat={spend.amount} cost />
        </span>
        <span className="text-sm">
          {tr.t('settings.spends.cost')} <Amount msat={spend.cost} cost />
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {ids.map(([label, value]) =>
          value === undefined ? null : (
            <div key={label} className="contents">
              <dt className="text-muted">{tr.t(label)}</dt>
              <dd className="min-w-0">
                <IdValue value={value} />
              </dd>
            </div>
          ),
        )}
        <dt className="text-muted">{tr.t('settings.spends.since')}</dt>
        <dd>{formatDateTime(spend.createdAt, tr.locale)}</dd>
        <dt className="text-muted">{tr.t('settings.spends.why')}</dt>
        <dd>{tr.t(spend.reason === 'interrupted' ? 'settings.spends.interrupted' : 'settings.spends.unclear')}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onResolve('succeeded')}>{tr.t('settings.spends.markSucceeded')}</Button>
        <Button variant="danger" onClick={() => onResolve('failed')}>
          {tr.t('settings.spends.markFailed')}
        </Button>
      </div>
    </li>
  );
}

export function SpendsScreen() {
  const api = useApi(),
    tr = useT(),
    queries = useQueryClient();
  const { node: only } = settingsSpendsRoute.useSearch();
  const nodes = useQuery(nodesQuery(api));
  const all = nodes.data?.items ?? [];
  const shown: NodeRow[] = only === undefined ? all : all.filter((n) => n.id === only);
  const lists = useQueries({ queries: shown.map((n) => unresolvedQuery(api, n.id)) });
  const guard = useSecurityGuard(tr.t('settings.spends.reason'));
  const [choice, setChoice] = useState<{ node: NodeRow; spend: Spend; outcome: Outcome; warning: string }>();
  const [result, setResult] = useState<string>(),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  const resolve = async () => {
    const target = choice;
    setChoice(undefined);
    if (!target) return;
    setError(undefined);
    setResult(undefined);
    setPending(true);
    try {
      const done = await guard.run(() =>
        api.call('resolveSpend', {
          params: { nodeId: target.node.id, intentId: target.spend.intentId },
          body: { outcome: target.outcome },
          userActivity: true,
        }),
      );
      if (done) setResult(tr.t(`settings.spends.resolved.${done.state}`));
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
      await queries.invalidateQueries({ queryKey: ['unresolved-spends', target.node.id] });
      await queries.invalidateQueries({ queryKey: ['spend-policy', target.node.id] });
    }
  };
  const total = lists.reduce((sum, q) => sum + (q.data?.items.length ?? 0), 0);
  const loaded = nodes.isSuccess && lists.every((q) => q.isSuccess);
  return (
    <SettingsPage title={tr.t('settings.spends.title')} intro={tr.t('settings.spends.intro')}>
      {all.length > 1 ? (
        <nav aria-label={tr.t('settings.spends.filter')} className="flex flex-wrap gap-3 text-sm">
          <Link
            to="/settings/spends"
            search={{}}
            aria-current={only === undefined ? 'page' : undefined}
            className="underline aria-[current=page]:font-semibold"
          >
            {tr.t('settings.spends.allNodes')}
          </Link>
          {all.map((n) => (
            <Link
              key={n.id}
              to="/settings/spends"
              search={{ node: n.id }}
              aria-current={only === n.id ? 'page' : undefined}
              className="underline aria-[current=page]:font-semibold"
            >
              {n.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {result ? <SuccessNote>{result}</SuccessNote> : null}
      {error ? (
        error instanceof ApiError && reasonOf(error) === 'broadcast' ? (
          <p role="alert" className="text-sm text-danger">
            {tr.t('settings.spends.broadcast')}
          </p>
        ) : (
          <ErrorNote error={error} />
        )
      ) : null}
      {loaded && total === 0 ? (
        <EmptyState title={tr.t('settings.spends.emptyTitle')} body={tr.t('settings.spends.emptyBody')} />
      ) : null}
      {shown.map((n, i) => {
        const list = lists[i];
        if (!list || (list.isSuccess && list.data.items.length === 0)) return null;
        return (
          <Card key={n.id} title={n.name}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <ChainBadge identity={n.chainIdentity} />
            </div>
            {list.isError ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
            {list.data ? (
              <>
                <p className="text-sm text-warning" data-testid="unresolved-warning">
                  {list.data.warning}
                </p>
                <ul className="flex flex-col divide-y divide-border">
                  {list.data.items.map((spend) => (
                    <SpendRow
                      key={spend.intentId}
                      spend={spend}
                      onResolve={(outcome) => setChoice({ node: n, spend, outcome, warning: list.data.warning })}
                    />
                  ))}
                </ul>
              </>
            ) : null}
          </Card>
        );
      })}
      <DestructiveConfirm
        open={choice !== undefined}
        onOpenChange={(open) => {
          if (!open) setChoice(undefined);
        }}
        title={tr.t(choice?.outcome === 'failed' ? 'settings.spends.markFailed' : 'settings.spends.markSucceeded')}
        consequences={
          <span className="flex flex-col gap-2">
            <span>
              {tr.t(choice?.outcome === 'failed' ? 'settings.spends.failedMeans' : 'settings.spends.succeededMeans')}
            </span>
            <span>{choice?.warning}</span>
          </span>
        }
        confirmLabel={tr.t(
          choice?.outcome === 'failed' ? 'settings.spends.markFailed' : 'settings.spends.markSucceeded',
        )}
        cancelLabel={tr.t('common.cancel')}
        onConfirm={() => void resolve()}
        pending={pending}
      />
      {guard.dialog}
    </SettingsPage>
  );
}
