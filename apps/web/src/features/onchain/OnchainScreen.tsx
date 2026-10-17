// On-chain wallet (U6, B6; route map: /n/:node/onchain and /onchain/tx/:txid, Advanced view): the wallet's balance,
// its coins and its transactions, newest first, with a CSV download of the loaded rows. Receiving is the Receive
// screen's on-chain tab; sending is /onchain/send. There is no transaction detail route on the server, so the detail
// screen finds its row among the newest transactions (data.ts).
import {
  Button,
  Card,
  DataTable,
  Field,
  PageHeader,
  SkeletonRows,
  StatusPill,
  sortFromParam,
  sortToParam,
  type Column,
  type Tone,
} from '@lightning-pilot/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodeRoute, onchainRoute, onchainTxRoute } from '../../app/router.tsx';
import { formatInteger } from '../../i18n/format.ts';
import { Amount, ErrorNote, IdValue } from '../../shell/parts.tsx';
import { useActionAllowed } from '../channels/parts.tsx';
import {
  explorerTxUrl,
  filterTransactions,
  KINDS,
  MAX_ROWS,
  STEP_ROWS,
  transactionQuery,
  transactionsCsv,
  transactionsQuery,
  utxosOf,
  utxosQuery,
  type OnchainSearch,
  type OnchainTx,
  type Utxo,
} from './data.ts';

const UTXO_TONES: Record<Utxo['status'], Tone> = {
  confirmed: 'success',
  unconfirmed: 'warning',
  immature: 'warning',
  spent: 'muted',
  unknown: 'muted',
};

export const ONCHAIN_DEFAULTS: OnchainSearch = { kind: 'all', sort: '-height', more: 0 };

function TxAmount({ tx }: { tx: OnchainTx }) {
  const tr = useT();
  if (!tx.amount) return <span className="text-muted">{tr.t('onchain.amountUnknown')}</span>;
  return (
    <span className={tx.amount.direction === 'in' ? 'text-success' : undefined}>
      {tr.t(tx.amount.direction === 'in' ? 'onchain.in' : 'onchain.out')} <Amount msat={tx.amount.value} />
    </span>
  );
}

function Confirmations({ tx }: { tx: OnchainTx }) {
  const tr = useT();
  return tx.confirmations === 0 ? (
    <StatusPill tone="warning" label={tr.t('onchain.unconfirmed')} />
  ) : (
    <span className="tabular-nums">{formatInteger(tx.confirmations, tr.locale)}</span>
  );
}

function TxLink({ txid }: { txid: string }) {
  const { node } = nodeRoute.useLoaderData();
  return (
    <Link
      className="font-mono text-brand-strong underline"
      to="/n/$node/onchain/tx/$txid"
      params={{ node: node.id, txid }}
      onClick={(e) => e.stopPropagation()}
    >
      {`${txid.slice(0, 8)}…${txid.slice(-8)}`}
    </Link>
  );
}

function ExplorerLink({ url }: { url: string }) {
  const tr = useT();
  return (
    <span className="flex flex-col gap-1">
      <a
        className="inline-flex min-h-11 items-center text-brand-strong underline"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="explorer-link"
      >
        {tr.t('onchain.explorer')}
      </a>
      <span className="text-xs text-muted">{tr.t('onchain.explorerPrivacy')}</span>
    </span>
  );
}

function UtxoTable({ rows, caption }: { rows: Utxo[] | undefined; caption: string }) {
  const tr = useT();
  const columns: Column<Utxo>[] = [
    {
      key: 'outpoint',
      header: tr.t('onchain.outpoint'),
      phone: 'primary',
      cell: (u) => (
        <span onClick={(e) => e.stopPropagation()}>
          <IdValue value={u.outpoint} />
        </span>
      ),
    },
    {
      key: 'amount',
      header: tr.t('onchain.amount'),
      align: 'right',
      phone: 'primary',
      cell: (u) => <Amount msat={u.amount} />,
    },
    {
      key: 'status',
      header: tr.t('onchain.status'),
      cell: (u) => (
        <span className="flex flex-wrap gap-2">
          <StatusPill tone={UTXO_TONES[u.status]} label={tr.t(`onchain.utxo.${u.status}`)} />
          {u.reserved ? (
            <StatusPill tone="info" label={tr.t('onchain.reserved')} title={tr.t('onchain.reservedHelp')} />
          ) : null}
        </span>
      ),
    },
    {
      key: 'height',
      header: tr.t('onchain.height'),
      align: 'right',
      cell: (u) => (u.blockHeight === undefined ? '—' : formatInteger(u.blockHeight, tr.locale)),
    },
  ];
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(u) => u.outpoint}
      empty={{ title: tr.t('onchain.noUtxos'), body: tr.t('onchain.noUtxosHelp') }}
      loadingLabel={tr.t('app.loading')}
      sortLabels={{
        ascending: tr.t('table.sortAscending'),
        descending: tr.t('table.sortDescending'),
        none: tr.t('table.sortNone'),
      }}
    />
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking in the same tick can cancel the download in Firefox and Safari (as the recovery-code download).
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function OnchainScreen() {
  const tr = useT(),
    api = useApi(),
    navigate = useNavigate();
  const { node } = nodeRoute.useLoaderData();
  const search = onchainRoute.useSearch();
  const canSend = useActionAllowed('onchain.send');
  const balances = useQuery({
    queryKey: ['balances', node.id],
    queryFn: () => api.call('balances', { params: { nodeId: node.id } }),
  });
  const utxos = useQuery(utxosQuery(api, node.id));
  const txs = useQuery(transactionsQuery(api, node.id, search.more));
  const go = (next: Partial<OnchainSearch>, replace = false) =>
    void navigate({ to: '/n/$node/onchain', params: { node: node.id }, search: { ...search, ...next }, replace });
  const rows = txs.data ? filterTransactions(txs.data.items, search.kind, search.sort) : undefined;
  const coins = utxos.data
    ? [...utxos.data.items].sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1))
    : undefined;

  const columns: Column<OnchainTx>[] = [
    { key: 'txid', header: tr.t('onchain.txid'), phone: 'primary', cell: (tx) => <TxLink txid={tx.txid} /> },
    {
      key: 'amount',
      header: tr.t('onchain.amount'),
      align: 'right',
      phone: 'primary',
      sortable: true,
      cell: (tx) => <TxAmount tx={tx} />,
    },
    { key: 'kind', header: tr.t('onchain.kind'), cell: (tx) => tr.t(`onchain.kind.${tx.kind}`) },
    {
      key: 'height',
      header: tr.t('onchain.height'),
      align: 'right',
      sortable: true,
      cell: (tx) => (tx.blockHeight === undefined ? '—' : formatInteger(tx.blockHeight, tr.locale)),
    },
    {
      key: 'confirmations',
      header: tr.t('onchain.confirmations'),
      align: 'right',
      cell: (tx) => <Confirmations tx={tx} />,
    },
    {
      key: 'fee',
      header: tr.t('onchain.fee'),
      align: 'right',
      cell: (tx) => (tx.fee === undefined ? '—' : <Amount msat={tx.fee} cost />),
    },
    {
      key: 'label',
      header: tr.t('onchain.label'),
      cell: (tx) => (tx.label ? <span className="break-all">{tx.label}</span> : null),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={tr.t('onchain.title')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              className="btn-secondary"
              to="/n/$node/receive"
              params={{ node: node.id }}
              search={{ tab: 'onchain' }}
            >
              {tr.t('onchain.receive')}
            </Link>
            {canSend ? (
              <Link className="btn-primary" to="/n/$node/onchain/send" params={{ node: node.id }} search={{}}>
                {tr.t('onchain.send')}
              </Link>
            ) : null}
          </div>
        }
      />
      <Card title={tr.t('onchain.balance')}>
        {balances.error ? <ErrorNote error={balances.error} onRetry={() => void balances.refetch()} /> : null}
        {balances.data ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted">{tr.t('onchain.confirmed')}</dt>
            <dd className="text-right text-2xl font-semibold md:text-[32px]">
              <Amount msat={balances.data.onchain.confirmed} testId="onchain-confirmed" />
            </dd>
            <dt className="text-muted">{tr.t('onchain.unconfirmedBalance')}</dt>
            <dd className="text-right">
              <Amount msat={balances.data.onchain.unconfirmed} />
            </dd>
            <dt className="text-muted">{tr.t('onchain.reservedBalance')}</dt>
            <dd className="text-right">
              <Amount msat={balances.data.onchain.reserved} testId="onchain-reserved" />
            </dd>
          </dl>
        ) : balances.isPending ? (
          <SkeletonRows label={tr.t('app.loading')} />
        ) : null}
      </Card>

      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="onchain-transactions">
        <h2 id="onchain-transactions" className="text-xl font-semibold">
          {tr.t('onchain.transactions')}
        </h2>
        <div className="flex flex-wrap items-end gap-4">
          <Field label={tr.t('onchain.kind')} htmlFor="onchain-kind">
            <select
              id="onchain-kind"
              className="input"
              value={search.kind}
              onChange={(e) => go({ kind: e.target.value as OnchainSearch['kind'] })}
            >
              {['all', ...KINDS].map((k) => (
                <option key={k} value={k}>
                  {tr.t(`onchain.kind.${k}`)}
                </option>
              ))}
            </select>
          </Field>
          <Button
            disabled={!rows || rows.length === 0}
            onClick={() =>
              download(
                `lightning-pilot-${node.name.replace(/[^A-Za-z0-9_-]+/g, '-')}-${node.chain}-onchain.csv`,
                transactionsCsv(rows ?? []),
              )
            }
          >
            {tr.t('onchain.csv')}
          </Button>
        </div>
        {txs.error ? <ErrorNote error={txs.error} onRetry={() => void txs.refetch()} /> : null}
        <DataTable
          caption={tr.t('onchain.transactions')}
          columns={columns}
          rows={rows ?? (txs.isPending ? undefined : [])}
          rowKey={(tx) => tx.txid}
          sort={sortFromParam(search.sort, ['height', 'amount'])}
          onSort={(next) => go({ sort: sortToParam(next) as OnchainSearch['sort'] })}
          onRowClick={(tx) =>
            void navigate({ to: '/n/$node/onchain/tx/$txid', params: { node: node.id, txid: tx.txid } })
          }
          empty={{ title: tr.t('onchain.noTransactions'), body: tr.t('onchain.noTransactionsHelp') }}
          loadingLabel={tr.t('app.loading')}
          sortLabels={{
            ascending: tr.t('table.sortAscending'),
            descending: tr.t('table.sortDescending'),
            none: tr.t('table.sortNone'),
          }}
        />
        {txs.data?.more ? (
          <div className="flex flex-col gap-2" data-testid="onchain-partial">
            <p className="text-sm">
              {tr.t('onchain.partial', { count: formatInteger(txs.data.items.length, tr.locale) })}
            </p>
            {(search.more + 1) * STEP_ROWS < MAX_ROWS ? (
              <Button className="self-start" onClick={() => go({ more: search.more + 1 })}>
                {tr.t('onchain.loadMore')}
              </Button>
            ) : (
              <p className="text-sm text-muted">
                {tr.t('onchain.bound', { count: formatInteger(MAX_ROWS, tr.locale) })}
              </p>
            )}
          </div>
        ) : null}
      </section>

      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="onchain-utxos">
        <h2 id="onchain-utxos" className="text-xl font-semibold">
          {tr.t('onchain.utxos')}
        </h2>
        {utxos.error ? <ErrorNote error={utxos.error} onRetry={() => void utxos.refetch()} /> : null}
        <UtxoTable rows={coins ?? (utxos.isPending ? undefined : [])} caption={tr.t('onchain.utxos')} />
      </section>
    </div>
  );
}

function Rows({ rows }: { rows: [string, ReactNode | undefined][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {rows
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 break-all">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function BackToWallet() {
  const tr = useT();
  const { node } = nodeRoute.useLoaderData();
  return (
    <Link
      className="inline-flex min-h-11 items-center text-brand-strong underline"
      to="/n/$node/onchain"
      params={{ node: node.id }}
      search={ONCHAIN_DEFAULTS}
    >
      {tr.t('onchain.back')}
    </Link>
  );
}

export function TransactionScreen() {
  const tr = useT(),
    api = useApi();
  const { node } = nodeRoute.useLoaderData();
  const { txid } = onchainTxRoute.useParams();
  const found = useQuery(transactionQuery(api, node.id, txid));
  const utxos = useQuery(utxosQuery(api, node.id));
  const tx = found.data?.tx;
  const explorer = tx ? explorerTxUrl(node.chain, node.network, tx.txid) : undefined;
  return (
    <div className="flex max-w-[720px] min-w-0 flex-col gap-6">
      <PageHeader title={tr.t('onchain.txTitle')} />
      {found.error ? <ErrorNote error={found.error} onRetry={() => void found.refetch()} /> : null}
      {found.isPending ? <SkeletonRows label={tr.t('app.loading')} /> : null}
      {found.data && !tx ? (
        <div className="flex flex-col gap-3" data-testid="onchain-missing">
          <p role="status">{tr.t('onchain.txMissing', { count: formatInteger(MAX_ROWS, tr.locale) })}</p>
          <p className="break-all font-mono text-sm">{txid}</p>
        </div>
      ) : null}
      {tx ? (
        <Card>
          <Rows
            rows={[
              [tr.t('onchain.txid'), <IdValue key="txid" value={tx.txid} full testId="onchain-txid" />],
              [tr.t('onchain.kind'), tr.t(`onchain.kind.${tx.kind}`)],
              [tr.t('onchain.amount'), <TxAmount key="amount" tx={tx} />],
              [tr.t('onchain.fee'), tx.fee === undefined ? tr.t('onchain.feeUnknown') : <Amount msat={tx.fee} cost />],
              [
                tr.t('onchain.confirmations'),
                <span key="conf" data-testid="onchain-confirmations">
                  <Confirmations tx={tx} />
                </span>,
              ],
              [
                tr.t('onchain.height'),
                tx.blockHeight === undefined ? undefined : formatInteger(tx.blockHeight, tr.locale),
              ],
              [tr.t('onchain.label'), tx.label],
              [tr.t('onchain.explorerLabel'), explorer ? <ExplorerLink key="explorer" url={explorer} /> : undefined],
            ]}
          />
        </Card>
      ) : null}
      {tx ? (
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="onchain-tx-utxos">
          <h2 id="onchain-tx-utxos" className="text-xl font-semibold">
            {tr.t('onchain.txUtxos')}
          </h2>
          {utxos.error ? <ErrorNote error={utxos.error} onRetry={() => void utxos.refetch()} /> : null}
          <UtxoTable
            rows={utxos.data ? utxosOf(utxos.data.items, tx.txid) : utxos.isPending ? undefined : []}
            caption={tr.t('onchain.txUtxos')}
          />
        </section>
      ) : null}
      <BackToWallet />
    </div>
  );
}
