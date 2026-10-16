import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button, Field, PageHeader } from '@lightning-pilot/ui';
import { CHANNEL_STATE_GROUPS } from '@lightning-pilot/core';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { channelsRoute, nodeRoute } from '../../app/router.tsx';
import { ErrorNote } from '../../shell/parts.tsx';
import { channelsQuery, filterChannels } from './data.ts';
import { ActionUnavailable, ChannelTable, useActionAllowed } from './parts.tsx';

export function ChannelsScreen() {
  const tr = useT(),
    api = useApi(),
    navigate = useNavigate();
  const { node } = nodeRoute.useLoaderData();
  const search = channelsRoute.useSearch();
  const data = useQuery(channelsQuery(api, node.id, search.pages, search.state === 'closed'));
  const allowed = useActionAllowed('channels.open');
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={tr.t('channels.title')}
        actions={
          allowed ? (
            <Link className="btn-primary" to="/n/$node/channels/open" params={{ node: node.id }} search={{}}>
              {tr.t('channels.open')}
            </Link>
          ) : undefined
        }
      />
      {!allowed ? <ActionUnavailable /> : null}
      <div className="flex flex-wrap gap-4">
        <Field label={tr.t('channels.sort')} htmlFor="channel-sort">
          <select
            id="channel-sort"
            className="input"
            value={search.sort}
            onChange={(e) =>
              void navigate({
                to: '/n/$node/channels',
                params: { node: node.id },
                search: { ...search, sort: e.target.value as typeof search.sort },
              })
            }
          >
            {['-capacity', 'capacity', '-local', 'local', '-remote', 'remote', 'peer', '-peer'].map((sort) => (
              <option key={sort} value={sort}>
                {tr.t(`channels.sort.${sort}`)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={tr.t('channels.filter')} htmlFor="channel-filter">
          <input
            id="channel-filter"
            type="search"
            className="input"
            value={search.q}
            onChange={(e) =>
              void navigate({
                to: '/n/$node/channels',
                params: { node: node.id },
                search: { ...search, q: e.target.value.slice(0, 200) },
                replace: true,
              })
            }
          />
        </Field>
        <Field label={tr.t('channels.state')} htmlFor="channel-state">
          <select
            id="channel-state"
            className="input"
            value={search.state}
            onChange={(e) =>
              void navigate({
                to: '/n/$node/channels',
                params: { node: node.id },
                search: { ...search, state: e.target.value as typeof search.state, pages: 1 },
              })
            }
          >
            {['all', ...CHANNEL_STATE_GROUPS].map((s) => (
              <option key={s} value={s}>
                {tr.t(`channels.state.${s}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {data.error ? <ErrorNote error={data.error} onRetry={() => void data.refetch()} /> : null}
      {data.error && data.data ? <p role="status">{tr.t('node.stale')}</p> : null}
      {data.data?.nextCursor ? <p role="note">{tr.t('channels.partial')}</p> : null}
      <ChannelTable
        rows={
          data.data
            ? filterChannels(data.data.items, search.state, search.q, search.sort)
            : data.isPending
              ? undefined
              : []
        }
        sort={search.sort}
        onSort={(sort) =>
          void navigate({
            to: '/n/$node/channels',
            params: { node: node.id },
            search: { ...search, sort: sort as typeof search.sort },
          })
        }
      />
      {data.data?.nextCursor && search.pages < 50 ? (
        <Button
          onClick={() =>
            void navigate({
              to: '/n/$node/channels',
              params: { node: node.id },
              search: { ...search, pages: search.pages + 1 },
            })
          }
        >
          {tr.t('channels.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
