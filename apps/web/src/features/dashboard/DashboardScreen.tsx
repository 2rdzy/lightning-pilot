// Node balances and liquidity, with the last chain check visible before the detail.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LiquidityBar, NodeAlias, SkeletonRows, StatusPill } from '@lightning-pilot/ui';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { Amount, Card, ErrorNote, useCopyLabels } from '../../shell/parts.tsx';
import { balancesQuery, nodeInfoQuery } from '../../app/queries.ts';
import { nodeRoute } from '../../app/router.tsx';
import { formatInteger, formatSats } from '../../i18n/format.ts';
import { IdentityPanel } from '../node/IdentityPanel.tsx';

export function DashboardScreen() {
  const tr = useT();
  const api = useApi();
  const copyLabels = useCopyLabels();
  const { node } = nodeRoute.useLoaderData();
  const balances = useQuery(balancesQuery(api, node.id));
  const info = useQuery(nodeInfoQuery(api, node.id));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{tr.t('dashboard.title')}</h1>
      <Card title={tr.t('node.identity')}>
        <IdentityPanel identity={info.data?.chainIdentity ?? node.chainIdentity} />
      </Card>
      {balances.error ? <ErrorNote error={balances.error} onRetry={() => void balances.refetch()} /> : null}
      {balances.error && balances.data ? (
        <p role="status" className="text-sm text-warning">
          {tr.t('node.stale')}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title={tr.t('dashboard.lightning')}>
          {balances.data ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted">{tr.t('dashboard.spendable')}</dt>
              <dd className="text-right text-2xl font-semibold md:text-[32px]">
                <Amount msat={balances.data.lightning.spendable} testId="balance-spendable" />
              </dd>
              <dt className="text-muted">{tr.t('dashboard.receivable')}</dt>
              <dd className="text-right">
                <Amount msat={balances.data.lightning.receivable} />
              </dd>
              <dt className="text-muted">{tr.t('dashboard.local')}</dt>
              <dd className="text-right">
                <Amount msat={balances.data.lightning.local} />
              </dd>
              <dt className="text-muted">{tr.t('dashboard.remote')}</dt>
              <dd className="text-right">
                <Amount msat={balances.data.lightning.remote} />
              </dd>
              <dt className="text-muted">{tr.t('dashboard.pendingClose')}</dt>
              <dd className="text-right">
                <Amount msat={balances.data.pendingClose} testId="balance-pending-close" />
              </dd>
            </dl>
          ) : balances.isPending ? (
            <SkeletonRows label={tr.t('app.loading')} />
          ) : null}
          {balances.data ? (
            <div className="mt-4">
              <LiquidityBar
                local={BigInt(balances.data.lightning.local)}
                remote={BigInt(balances.data.lightning.remote)}
                localText={tr.t('amount.sat', { amount: formatSats(BigInt(balances.data.lightning.local), tr.locale) })}
                remoteText={tr.t('amount.sat', {
                  amount: formatSats(BigInt(balances.data.lightning.remote), tr.locale),
                })}
                label={tr.t('dashboard.liquidity', {
                  local: formatSats(BigInt(balances.data.lightning.local), tr.locale),
                  remote: formatSats(BigInt(balances.data.lightning.remote), tr.locale),
                })}
              />
              <p className="mt-2 text-xs text-muted">{tr.t('dashboard.liquidityHelp')}</p>
            </div>
          ) : null}
        </Card>
        <Card title={tr.t('dashboard.onchain')}>
          {balances.data ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted">{tr.t('dashboard.confirmed')}</dt>
              <dd className="text-right text-2xl font-semibold md:text-[32px]">
                <Amount msat={balances.data.onchain.confirmed} testId="balance-onchain" />
              </dd>
              <dt className="text-muted">{tr.t('dashboard.unconfirmed')}</dt>
              <dd className="text-right">
                <Amount msat={balances.data.onchain.unconfirmed} />
              </dd>
              <dt className="text-muted">{tr.t('dashboard.reserved')}</dt>
              <dd className="text-right">
                <Amount msat={balances.data.onchain.reserved} testId="balance-reserved" />
              </dd>
            </dl>
          ) : balances.isPending ? (
            <SkeletonRows label={tr.t('app.loading')} />
          ) : null}
        </Card>
      </div>
      <Card title={tr.t('dashboard.node')}>
        {info.error ? <ErrorNote error={info.error} onRetry={() => void info.refetch()} /> : null}
        {info.error && info.data ? (
          <p role="status" className="text-sm text-warning">
            {tr.t('node.stale')}
          </p>
        ) : null}
        {info.isPending ? <SkeletonRows label={tr.t('app.loading')} /> : null}
        {info.data ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">{tr.t('dashboard.alias')}</dt>
            <dd className="min-w-0">
              <NodeAlias alias={info.data.alias} pubkey={info.data.pubkey} labels={copyLabels} />
            </dd>
            <dt className="text-muted">{tr.t('dashboard.height')}</dt>
            <dd className="tabular-nums">{formatInteger(info.data.blockHeight, tr.locale)}</dd>
            <dt className="text-muted">{tr.t('node.sync')}</dt>
            <dd>
              <StatusPill
                tone={info.data.synced ? 'success' : 'warning'}
                label={tr.t(info.data.synced ? 'node.synced' : 'node.syncing')}
              />
            </dd>
          </dl>
        ) : null}
        {info.data ? (
          <ul className="text-muted mt-2 flex flex-wrap gap-4 text-sm">
            <li>{tr.plural('dashboard.channels', info.data.numActiveChannels)}</li>
            <li>{tr.plural('dashboard.pendingChannels', info.data.numPendingChannels)}</li>
            <li>{tr.plural('dashboard.inactiveChannels', info.data.numInactiveChannels)}</li>
            <li>{tr.plural('dashboard.peers', info.data.numPeers)}</li>
          </ul>
        ) : null}
        <Link
          className="mt-4 inline-flex min-h-11 items-center text-sm text-brand-strong underline"
          to="/n/$node/node"
          params={{ node: node.id }}
        >
          {tr.t('dashboard.nodeDetails')}
        </Link>
      </Card>
    </div>
  );
}
