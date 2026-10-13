// Dashboard (walking skeleton): the node's key facts and its balances, summary first (style guide §5).
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { Amount, Card, ErrorNote } from '../../app/parts.tsx';
import { balancesQuery, nodeInfoQuery } from '../../app/queries.ts';
import { nodeRoute } from '../../app/router.tsx';
import { formatInteger, shortId } from '../../i18n/format.ts';

export function DashboardScreen() {
  const tr = useT();
  const api = useApi();
  const { node } = nodeRoute.useLoaderData();
  const balances = useQuery(balancesQuery(api, node.id));
  const info = useQuery(nodeInfoQuery(api, node.id));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{tr.t('dashboard.title')}</h1>
      {balances.error ? <ErrorNote error={balances.error} onRetry={() => void balances.refetch()} /> : null}
      <div className="grid gap-4 md:grid-cols-2">
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
            </dl>
          ) : (
            <p className="text-muted">{tr.t('app.loading')}</p>
          )}
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
            </dl>
          ) : (
            <p className="text-muted">{tr.t('app.loading')}</p>
          )}
        </Card>
      </div>
      <Card title={tr.t('dashboard.node')}>
        {info.error ? <ErrorNote error={info.error} onRetry={() => void info.refetch()} /> : null}
        {info.data ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">{tr.t('dashboard.alias')}</dt>
            {/* Node aliases are untrusted text: React escapes them; cut to 32 characters (style guide §6). */}
            <dd>{info.data.alias.slice(0, 32)}</dd>
            <dt className="text-muted">{tr.t('dashboard.pubkey')}</dt>
            <dd className="font-mono" title={info.data.pubkey}>
              {shortId(info.data.pubkey)}
            </dd>
            <dt className="text-muted">{tr.t('dashboard.height')}</dt>
            <dd className="tabular-nums">{formatInteger(info.data.blockHeight, tr.locale)}</dd>
          </dl>
        ) : null}
        {info.data ? (
          <ul className="text-muted mt-2 flex gap-4 text-sm">
            <li>{tr.plural('dashboard.channels', info.data.numActiveChannels)}</li>
            <li>{tr.plural('dashboard.peers', info.data.numPeers)}</li>
          </ul>
        ) : null}
      </Card>
    </div>
  );
}
