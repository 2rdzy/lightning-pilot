import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { DataTable, Field, NodeAlias, PageHeader, StatusPill, sortFromParam, sortToParam } from '@lightning-pilot/ui';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodeRoute, peersRoute } from '../../app/router.tsx';
import { ErrorNote, useCopyLabels } from '../../shell/parts.tsx';
import { ActionUnavailable, useActionAllowed } from '../channels/parts.tsx';
import { peerFeatures, peersQuery } from './data.ts';

export function PeersScreen() {
  const api = useApi(),
    tr = useT(),
    labels = useCopyLabels(),
    navigate = useNavigate();
  const { node } = nodeRoute.useLoaderData();
  const search = peersRoute.useSearch();
  const query = useQuery(peersQuery(api, node.id));
  const allowed = useActionAllowed('peers.manage');
  const rows = query.data?.items
    .filter((p) => `${p.pubkey} ${p.alias ?? ''}`.toLowerCase().includes(search.q.toLowerCase()))
    .sort((a, b) => (search.sort.startsWith('-') ? -1 : 1) * (a.alias ?? a.pubkey).localeCompare(b.alias ?? b.pubkey));
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={tr.t('peers.title')}
        actions={
          allowed ? (
            <Link className="btn-primary" to="/n/$node/peers/connect" params={{ node: node.id }} search={{}}>
              {tr.t('peers.connect')}
            </Link>
          ) : undefined
        }
      />
      {!allowed ? <ActionUnavailable /> : null}
      <Field label={tr.t('peers.filter')} htmlFor="peer-filter">
        <input
          id="peer-filter"
          className="input max-w-md"
          type="search"
          value={search.q}
          onChange={(e) =>
            void navigate({
              to: '/n/$node/peers',
              params: { node: node.id },
              search: { ...search, q: e.target.value.slice(0, 200) },
              replace: true,
            })
          }
        />
      </Field>
      {query.error ? <ErrorNote error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.error && query.data ? <p role="status">{tr.t('node.stale')}</p> : null}
      <DataTable
        caption={tr.t('peers.title')}
        rows={rows ?? (query.isPending ? undefined : [])}
        rowKey={(p) => p.pubkey}
        columns={[
          {
            key: 'peer',
            header: tr.t('channels.peer'),
            phone: 'primary',
            sortable: true,
            cell: (p) => (
              <div className="flex flex-col gap-1">
                <Link
                  className="min-h-11 font-mono text-brand-strong underline"
                  to="/n/$node/peers/$pubkey"
                  params={{ node: node.id, pubkey: p.pubkey }}
                  search={{ ...search, pages: 1 }}
                >
                  {tr.t('peers.details')}
                </Link>
                <NodeAlias alias={p.alias ?? tr.t('peers.unknownAlias')} pubkey={p.pubkey} labels={labels} />
              </div>
            ),
          },
          {
            key: 'state',
            header: tr.t('channels.state'),
            phone: 'primary',
            cell: (p) => (
              <StatusPill
                tone={p.connected ? 'success' : 'muted'}
                label={tr.t(p.connected ? 'peers.connected' : 'peers.disconnected')}
              />
            ),
          },
          { key: 'channels', header: tr.t('channels.title'), align: 'right', cell: (p) => String(p.numChannels) },
          {
            key: 'features',
            header: tr.t('peers.features'),
            cell: (p) =>
              peerFeatures(p.features)
                .map((key) => tr.t(key))
                .join(', ') || tr.t('peers.noKnownFeatures'),
          },
        ]}
        sort={sortFromParam(search.sort, ['peer'])}
        onSort={(sort) =>
          void navigate({
            to: '/n/$node/peers',
            params: { node: node.id },
            search: { ...search, sort: sortToParam(sort) as typeof search.sort },
          })
        }
        empty={{ title: tr.t('peers.empty'), body: tr.t('peers.emptyHelp') }}
        loadingLabel={tr.t('app.loading')}
        sortLabels={{
          ascending: tr.t('table.sortAscending'),
          descending: tr.t('table.sortDescending'),
          none: tr.t('table.sortNone'),
        }}
      />
    </div>
  );
}
