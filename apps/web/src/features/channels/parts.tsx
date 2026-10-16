import type { ReactNode } from 'react';
import { ZodError } from 'zod';
import { ApiError } from '../../api/client.ts';
import type { Capability } from '@lightning-pilot/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  DataTable,
  Dialog,
  LiquidityBar,
  NodeAlias,
  StatusPill,
  sortFromParam,
  sortToParam,
  type Column,
} from '@lightning-pilot/ui';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodeRoute } from '../../app/router.tsx';
import { formatSats } from '../../i18n/format.ts';
import { Amount, useCopyLabels } from '../../shell/parts.tsx';
import { usePreferences } from '../../shell/preferences-context.tsx';
import { nodeDetailsQuery } from '../node/queries.ts';
import { channelRef, type ChannelRow } from './data.ts';

export function ReplayWarning() {
  const tr = useT();
  return (
    <p
      className="rounded-control border border-warning p-2 text-sm text-text"
      role="note"
      data-testid="channel-replay-warning"
    >
      {tr.t('channels.replayWarning')}
    </p>
  );
}

export function ChannelLiquidity({ local, remote }: { local: string; remote: string }) {
  const tr = useT();
  const left = formatSats(BigInt(local), tr.locale),
    right = formatSats(BigInt(remote), tr.locale);
  return (
    <div className="w-56 min-w-0 max-w-full">
      <LiquidityBar
        local={BigInt(local)}
        remote={BigInt(remote)}
        localText={tr.t('amount.sat', { amount: left })}
        remoteText={tr.t('amount.sat', { amount: right })}
        label={tr.t('dashboard.liquidity', { local: left, remote: right })}
      />
    </div>
  );
}

export function ChannelTable({
  rows,
  sort = '-capacity',
  onSort,
}: {
  rows: ChannelRow[] | undefined;
  sort?: string;
  onSort?: (sort: string) => void;
}) {
  const tr = useT(),
    labels = useCopyLabels();
  const { node } = nodeRoute.useLoaderData();
  const columns: Column<ChannelRow>[] = [
    {
      key: 'channel',
      header: tr.t('channels.channel'),
      phone: 'primary',
      cell: (row) => (
        <div className="flex flex-col gap-2">
          <Link
            className="font-mono break-all text-brand-strong underline"
            to="/n/$node/channels/$channel"
            params={{ node: node.id, channel: channelRef(row) }}
            search={{ tab: 'overview' }}
          >
            {row.shortChannelId ?? row.id.slice(0, 16)}
          </Link>
          {'replayableOnOtherChain' in row && row.replayableOnOtherChain ? <ReplayWarning /> : null}
        </div>
      ),
    },
    {
      key: 'peer',
      header: tr.t('channels.peer'),
      phone: 'primary',
      sortable: true,
      cell: (row) =>
        row.peer ? (
          <span onClick={(e) => e.stopPropagation()}>
            <NodeAlias alias={row.peer.alias ?? tr.t('peers.unknownAlias')} pubkey={row.peer.pubkey} labels={labels} />
          </span>
        ) : (
          tr.t('channels.unavailable')
        ),
    },
    {
      key: 'capacity',
      header: tr.t('channels.capacity'),
      align: 'right',
      sortable: true,
      cell: (row) => <Amount msat={row.capacity} />,
    },
    {
      key: 'local',
      header: tr.t('channels.local'),
      align: 'right',
      sortable: true,
      cell: (row) => <Amount msat={'local' in row ? row.local : row.finalLocal} />,
    },
    {
      key: 'remote',
      header: tr.t('channels.remote'),
      align: 'right',
      sortable: true,
      cell: (row) => ('remote' in row ? <Amount msat={row.remote} /> : tr.t('channels.unavailable')),
    },
    {
      key: 'state',
      header: tr.t('channels.state'),
      cell: (row) => (
        <StatusPill
          tone={
            'state' in row && row.state.group === 'active'
              ? 'success'
              : 'state' in row && ['opening', 'closing'].includes(row.state.group)
                ? 'warning'
                : 'muted'
          }
          label={
            'state' in row
              ? row.state.group === 'active'
                ? tr.t('channels.state.active')
                : row.state.nativeLabel
              : tr.t('channels.closed')
          }
          title={'state' in row ? row.state.native : row.closeCauseRaw}
        />
      ),
    },
    {
      key: 'liquidity',
      header: tr.t('channels.liquidity'),
      cell: (row) =>
        'local' in row ? <ChannelLiquidity local={row.local} remote={row.remote} /> : tr.t('channels.unavailable'),
    },
  ];
  const navigate = useNavigate();
  return (
    <DataTable
      caption={tr.t('channels.title')}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      sort={sortFromParam(sort, ['peer', 'capacity', 'local', 'remote'])}
      {...(onSort ? { onSort: (next) => onSort(sortToParam(next)) } : {})}
      onRowClick={(row) =>
        void navigate({
          to: '/n/$node/channels/$channel',
          params: { node: node.id, channel: channelRef(row) },
          search: { tab: 'overview' },
        })
      }
      empty={{ title: tr.t('channels.empty'), body: tr.t('channels.emptyHelp') }}
      loadingLabel={tr.t('app.loading')}
      sortLabels={{
        ascending: tr.t('table.sortAscending'),
        descending: tr.t('table.sortDescending'),
        none: tr.t('table.sortNone'),
      }}
    />
  );
}

export function useActionAllowed(capability: Capability) {
  const api = useApi();
  const { node } = nodeRoute.useLoaderData();
  const info = useQuery(nodeDetailsQuery(api, node.id));
  return (
    node.canSpend &&
    !info.error &&
    info.data?.chainIdentity.state === 'confirmed' &&
    info.data.capabilities.includes(capability)
  );
}

export function ActionUnavailable() {
  const tr = useT();
  return (
    <p role="note" className="rounded-control border border-warning p-3 text-sm">
      {tr.t('channels.actionUnavailable')}
    </p>
  );
}

// Action routes stay addressable; closing a dialog returns to the explicit parent URL, even after a deep link.
export function ActionFrame({ title, children, back }: { title: string; children: ReactNode; back: string }) {
  const tr = useT(),
    navigate = useNavigate();
  const { isPhone } = usePreferences();
  const leave = () => void navigate({ to: back });
  return isPhone ? (
    <div className="mx-auto flex max-w-[640px] flex-col gap-4">
      <Button onClick={leave}>{tr.t('channels.back')}</Button>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </div>
  ) : (
    <>
      <Button onClick={leave}>{tr.t('channels.back')}</Button>
      <Dialog
        open
        title={title}
        closeLabel={tr.t('common.close')}
        onOpenChange={(open) => {
          if (!open) leave();
        }}
      >
        {children}
      </Dialog>
    </>
  );
}

export function inputError(error: unknown): unknown {
  return error instanceof ZodError ? new ApiError('validation_failed', 'Invalid form input', 400) : error;
}
