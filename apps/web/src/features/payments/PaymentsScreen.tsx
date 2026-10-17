// Payments and invoices (D11): sent payments and received invoices, newest first, from the node's own history.
// Status, text filter, sort and page live in the URL. Only a bounded number of node pages is read (data.ts); when
// the node has more, the screen says so and offers to read further.
import {
  Button,
  DataTable,
  Field,
  PageHeader,
  SegmentedControl,
  StatusPill,
  sortFromParam,
  sortToParam,
  type Column,
  type Tone,
} from '@lightning-pilot/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodeRoute, paymentsRoute } from '../../app/router.tsx';
import { formatDateTime } from '../../i18n/format.ts';
import { Amount, ErrorNote, IdValue } from '../../shell/parts.tsx';
import {
  filterHistory,
  historyQuery,
  MAX_STEPS,
  RECEIVED_STATUSES,
  SENT_STATUSES,
  STEP_PAGES,
  READ_LIMIT,
  statusOf,
  viewPage,
  type HistoryRow,
  type PaymentsSearch,
} from './data.ts';

const TONES: Record<string, Tone> = {
  succeeded: 'success',
  paid: 'success',
  pending: 'warning',
  unpaid: 'info',
  failed: 'danger',
  expired: 'muted',
};

export function HistoryStatus({ status }: { status: string }) {
  const tr = useT();
  return <StatusPill tone={TONES[status] ?? 'muted'} label={tr.t(`payments.status.${status}`)} />;
}

export function PaymentsScreen() {
  const tr = useT(),
    api = useApi(),
    navigate = useNavigate();
  const { node } = nodeRoute.useLoaderData();
  const search = paymentsRoute.useSearch();
  const status = statusOf(search.tab, search.status);
  const data = useQuery(historyQuery(api, node.id, search.tab, search.more));
  const go = (next: Partial<PaymentsSearch>, replace = false) =>
    void navigate({ to: '/n/$node/payments', params: { node: node.id }, search: { ...search, ...next }, replace });
  const filtered = data.data ? filterHistory(data.data.rows, status, search.q, search.sort) : undefined;
  const view = filtered ? viewPage(filtered, search.page) : undefined;
  const detail = (row: HistoryRow) =>
    search.tab === 'sent'
      ? ({ to: '/n/$node/payments/$hash', params: { node: node.id, hash: row.hash } } as const)
      : ({ to: '/n/$node/invoices/$hash', params: { node: node.id, hash: row.hash } } as const);

  const columns: Column<HistoryRow>[] = [
    {
      key: 'time',
      header: tr.t('payments.time'),
      phone: 'primary',
      sortable: true,
      cell: (row) =>
        row.time ? (
          <time dateTime={row.time} title={row.time}>
            {formatDateTime(row.time, tr.locale)}
          </time>
        ) : (
          tr.t('payments.unknownTime')
        ),
    },
    {
      key: 'amount',
      header: tr.t('payments.amount'),
      align: 'right',
      phone: 'primary',
      sortable: true,
      cell: (row) => (row.amount ? <Amount msat={row.amount} /> : tr.t('payments.anyAmount')),
    },
    { key: 'status', header: tr.t('payments.statusLabel'), cell: (row) => <HistoryStatus status={row.status} /> },
    {
      key: 'hash',
      header: tr.t('payments.hash'),
      cell: (row) => (
        <Link className="font-mono text-brand-strong underline" {...detail(row)}>
          {`${row.hash.slice(0, 8)}…${row.hash.slice(-8)}`}
        </Link>
      ),
    },
    {
      key: 'text',
      header: tr.t(search.tab === 'sent' ? 'payments.labelOrPayee' : 'payments.description'),
      cell: (row) =>
        row.text ? (
          <span className="break-all">{row.text}</span>
        ) : row.counterparty ? (
          <span onClick={(e) => e.stopPropagation()}>
            <IdValue value={row.counterparty} />
          </span>
        ) : null,
    },
  ];
  const statuses = ['all', ...(search.tab === 'sent' ? SENT_STATUSES : RECEIVED_STATUSES)];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={tr.t('payments.title')}
        actions={
          <div className="flex gap-2">
            <Link className="btn-secondary" to="/n/$node/receive" params={{ node: node.id }} search={{}}>
              {tr.t('nav.receive')}
            </Link>
            <Link className="btn-primary" to="/n/$node/pay" params={{ node: node.id }} search={{}}>
              {tr.t('nav.pay')}
            </Link>
          </div>
        }
      />
      <SegmentedControl
        label={tr.t('payments.tabs')}
        value={search.tab}
        options={[
          { value: 'sent', label: tr.t('payments.tab.sent') },
          { value: 'received', label: tr.t('payments.tab.received') },
        ]}
        onChange={(tab) => go({ tab, status: 'all', page: 1, more: 0 })}
        testId="payments-tab"
      />
      <div className="flex flex-wrap gap-4">
        <Field label={tr.t('payments.statusLabel')} htmlFor="payments-status">
          <select
            id="payments-status"
            className="input"
            value={status}
            onChange={(e) => go({ status: e.target.value as PaymentsSearch['status'], page: 1 })}
          >
            {statuses.map((s) => (
              <option key={s} value={s}>
                {tr.t(`payments.status.${s}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tr.t('payments.filter')} htmlFor="payments-filter">
          <input
            id="payments-filter"
            type="search"
            className="input"
            value={search.q}
            onChange={(e) => go({ q: e.target.value.slice(0, 200), page: 1 }, true)}
          />
        </Field>
      </div>
      {data.error ? <ErrorNote error={data.error} onRetry={() => void data.refetch()} /> : null}
      {data.data?.more ? (
        <div
          role="note"
          className="flex flex-col gap-2 rounded-control border border-warning p-3 text-sm"
          data-testid="history-partial"
        >
          <p>{tr.t('payments.partial', { count: (search.more + 1) * STEP_PAGES * READ_LIMIT })}</p>
          {search.more + 1 < MAX_STEPS ? (
            <Button className="self-start" onClick={() => go({ more: search.more + 1 })}>
              {tr.t('payments.readMore')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <DataTable
        caption={tr.t(search.tab === 'sent' ? 'payments.tab.sent' : 'payments.tab.received')}
        columns={columns}
        rows={view?.rows ?? (data.isPending ? undefined : [])}
        rowKey={(row) => row.hash}
        sort={sortFromParam(search.sort, ['time', 'amount'])}
        onSort={(next) => go({ sort: sortToParam(next) as PaymentsSearch['sort'], page: 1 })}
        onRowClick={(row) => void navigate(detail(row))}
        empty={{
          title: tr.t(search.tab === 'sent' ? 'payments.emptySent' : 'payments.emptyReceived'),
          body: tr.t(search.tab === 'sent' ? 'payments.emptySentHelp' : 'payments.emptyReceivedHelp'),
        }}
        loadingLabel={tr.t('app.loading')}
        sortLabels={{
          ascending: tr.t('table.sortAscending'),
          descending: tr.t('table.sortDescending'),
          none: tr.t('table.sortNone'),
        }}
      />
      {view && view.pages > 1 ? (
        <nav className="flex items-center gap-3" aria-label={tr.t('payments.pages')}>
          <Button disabled={view.page <= 1} onClick={() => go({ page: view.page - 1 })}>
            {tr.t('payments.previous')}
          </Button>
          <span className="text-sm" data-testid="history-page">
            {tr.t('payments.pageOf', { page: view.page, pages: view.pages })}
          </span>
          <Button disabled={view.page >= view.pages} onClick={() => go({ page: view.page + 1 })}>
            {tr.t('payments.next')}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
