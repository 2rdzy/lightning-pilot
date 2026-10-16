import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Card, PageHeader, SkeletonRows, StatusPill } from '@lightning-pilot/ui';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { channelRoute, nodeRoute } from '../../app/router.tsx';
import { Amount, ErrorNote, IdValue } from '../../shell/parts.tsx';
import { formatDateTime, formatInteger } from '../../i18n/format.ts';
import { channelQuery } from './data.ts';
import { ChannelLiquidity, ReplayWarning, useActionAllowed } from './parts.tsx';

export function ChannelScreen() {
  const api = useApi(),
    tr = useT();
  const { node } = nodeRoute.useLoaderData();
  const { channel } = channelRoute.useParams();
  const { tab } = channelRoute.useSearch();
  const query = useQuery(channelQuery(api, node.id, channel));
  const allowed = useActionAllowed('channels.close');
  const row = query.data;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={tr.t('channels.detail')}
        actions={
          row && 'local' in row && allowed && !['closed', 'closing'].includes(row.state.group) ? (
            <Link
              className="btn-secondary"
              to="/n/$node/channels/$channel/close"
              params={{ node: node.id, channel }}
              search={{ force: '0' }}
            >
              {tr.t('channels.close')}
            </Link>
          ) : undefined
        }
      />
      {query.error ? <ErrorNote error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.error && row ? <p role="status">{tr.t('node.stale')}</p> : null}
      {query.isPending ? <SkeletonRows label={tr.t('app.loading')} /> : null}
      {row ? (
        <>
          {'replayableOnOtherChain' in row && row.replayableOnOtherChain ? <ReplayWarning /> : null}
          <nav aria-label={tr.t('channels.tabs')} className="flex gap-4">
            {(['overview', 'policy'] as const).map((next) => (
              <Link
                key={next}
                className="inline-flex min-h-11 items-center text-brand-strong underline"
                aria-current={tab === next ? 'page' : undefined}
                to="/n/$node/channels/$channel"
                params={{ node: node.id, channel }}
                search={{ tab: next }}
              >
                {tr.t(`channels.${next}`)}
              </Link>
            ))}
          </nav>
          {tab === 'policy' ? (
            <Card title={tr.t('channels.policy')}>
              {'policy' in row && row.policy ? (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 text-sm">
                  <dt>{tr.t('channels.baseFee')}</dt>
                  <dd>
                    <Amount msat={row.policy.baseFeeMsat} cost />
                  </dd>
                  <dt>{tr.t('channels.feePpm')}</dt>
                  <dd>{formatInteger(row.policy.feePpm, tr.locale)}</dd>
                  <dt>{tr.t('channels.minHtlc')}</dt>
                  <dd>
                    <Amount msat={row.policy.minHtlcMsat} cost />
                  </dd>
                  <dt>{tr.t('channels.maxHtlc')}</dt>
                  <dd>
                    <Amount msat={row.policy.maxHtlcMsat} cost />
                  </dd>
                  <dt>{tr.t('channels.cltv')}</dt>
                  <dd>{formatInteger(row.policy.cltvDelta, tr.locale)}</dd>
                </dl>
              ) : (
                <p>{tr.t('channels.noPolicy')}</p>
              )}
              <p className="mt-4 text-sm text-muted">{tr.t('channels.policyReadOnly')}</p>
            </Card>
          ) : (
            <>
              <Card title={tr.t('channels.overview')}>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 text-sm">
                  <dt>{tr.t('channels.channel')}</dt>
                  <dd>
                    <IdValue value={row.id} full />
                  </dd>
                  <dt>{tr.t('channels.scid')}</dt>
                  <dd>{row.shortChannelId ?? tr.t('channels.unavailable')}</dd>
                  <dt>{tr.t('channels.funding')}</dt>
                  <dd>
                    <IdValue value={row.fundingOutpoint} full />
                  </dd>
                  <dt>{tr.t('channels.peer')}</dt>
                  <dd>
                    {row.peer ? (
                      <Link
                        className="break-all font-mono text-brand-strong underline"
                        to="/n/$node/peers/$pubkey"
                        params={{ node: node.id, pubkey: row.peer.pubkey }}
                        search={{ state: 'all', q: '', sort: 'peer', pages: 1 }}
                      >
                        {row.peer.pubkey}
                      </Link>
                    ) : (
                      tr.t('channels.unavailable')
                    )}
                  </dd>
                  <dt>{tr.t('channels.state')}</dt>
                  <dd>
                    <StatusPill
                      tone={'state' in row && row.state.group === 'active' ? 'success' : 'muted'}
                      label={
                        'state' in row
                          ? row.state.group === 'active'
                            ? tr.t('channels.state.active')
                            : row.state.nativeLabel
                          : tr.t('channels.closed')
                      }
                      title={'state' in row ? row.state.native : row.closeCauseRaw}
                    />
                  </dd>
                  <dt>{tr.t('channels.capacity')}</dt>
                  <dd>
                    <Amount msat={row.capacity} />
                  </dd>
                  <dt>{tr.t('channels.local')}</dt>
                  <dd>
                    <Amount msat={'local' in row ? row.local : row.finalLocal} />
                  </dd>
                  {'local' in row ? (
                    <>
                      <dt>{tr.t('channels.remote')}</dt>
                      <dd>
                        <Amount msat={row.remote} />
                      </dd>
                      <dt>{tr.t('dashboard.spendable')}</dt>
                      <dd>
                        <Amount msat={row.spendable} />
                      </dd>
                      <dt>{tr.t('dashboard.receivable')}</dt>
                      <dd>
                        <Amount msat={row.receivable} />
                      </dd>
                      <dt>{tr.t('channels.reserveOurs')}</dt>
                      <dd>
                        <Amount msat={row.reserves.ours} />
                      </dd>
                      <dt>{tr.t('channels.reserveTheirs')}</dt>
                      <dd>
                        <Amount msat={row.reserves.theirs} />
                      </dd>
                      <dt>{tr.t('channels.opener')}</dt>
                      <dd>{tr.t(`channels.opener.${row.opener}`)}</dd>
                      <dt>{tr.t('channels.visibility')}</dt>
                      <dd>{tr.t(row.private ? 'channels.private' : 'channels.public')}</dd>
                      <dt>{tr.t('channels.type')}</dt>
                      <dd className="break-words">{row.channelType.join(', ') || tr.t('channels.unavailable')}</dd>
                      <dt>{tr.t('channels.incoming')}</dt>
                      <dd>
                        <Amount msat={row.stats.inFulfilled} /> · {formatInteger(row.stats.inPayments, tr.locale)}
                      </dd>
                      <dt>{tr.t('channels.outgoing')}</dt>
                      <dd>
                        <Amount msat={row.stats.outFulfilled} /> · {formatInteger(row.stats.outPayments, tr.locale)}
                      </dd>
                      {row.closeTo ? (
                        <>
                          <dt>{tr.t('channels.destination')}</dt>
                          <dd>
                            <IdValue value={row.closeTo} full />
                          </dd>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <dt>{tr.t('channels.closeCause')}</dt>
                      <dd title={row.closeCauseRaw}>{row.closeCause}</dd>
                      <dt>{tr.t('channels.closingTx')}</dt>
                      <dd>
                        {row.closingTxid ? <IdValue value={row.closingTxid} full /> : tr.t('channels.unavailable')}
                      </dd>
                      <dt>{tr.t('channels.closedAt')}</dt>
                      <dd>
                        {row.closedAt ? (
                          <time dateTime={row.closedAt} title={row.closedAt}>
                            {formatDateTime(row.closedAt, tr.locale)}
                          </time>
                        ) : (
                          tr.t('channels.unavailable')
                        )}
                      </dd>
                    </>
                  )}
                </dl>
                {'local' in row ? (
                  <div className="mt-4">
                    <ChannelLiquidity local={row.local} remote={row.remote} />
                  </div>
                ) : null}
              </Card>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
