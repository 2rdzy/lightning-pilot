// Payment detail (/payments/:hash) and invoice detail (/invoices/:hash), read from the node. The invoice page is
// where Receive lands after creating one: it shows the QR code while the invoice is open and turns to "Paid" when
// the node reports it, through the shell's live connection (invoice.paid refreshes the read). The payment page has
// no preimage: the read API never returns one (only the pay screen's own result does).
import { Card, PageHeader, QrBlock } from '@lightning-pilot/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ApiError } from '../../api/client.ts';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { invoiceRoute, nodeRoute, paymentRoute } from '../../app/router.tsx';
import { formatDateTime } from '../../i18n/format.ts';
import { Amount, ChainBadge, ErrorNote, IdValue, useCopyLabels } from '../../shell/parts.tsx';
import { HistoryStatus } from './PaymentsScreen.tsx';

function When({ iso }: { iso: string }) {
  const tr = useT();
  return (
    <time dateTime={iso} title={iso}>
      {formatDateTime(iso, tr.locale)}
    </time>
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

function BackLink({ tab }: { tab: 'sent' | 'received' }) {
  const tr = useT();
  const { node } = nodeRoute.useLoaderData();
  return (
    <Link
      className="inline-flex min-h-11 items-center text-brand-strong underline"
      to="/n/$node/payments"
      params={{ node: node.id }}
      search={{ tab, status: 'all', q: '', sort: '-time', more: 0, page: 1 }}
    >
      {tr.t('payments.back')}
    </Link>
  );
}

// A 404 from the node is an answer ("the node has no such record"), not a broken page.
function Missing({ text, tab }: { text: string; tab: 'sent' | 'received' }) {
  return (
    <div className="flex flex-col gap-3" data-testid="history-missing">
      <p role="status">{text}</p>
      <BackLink tab={tab} />
    </div>
  );
}

export function PaymentScreen() {
  const tr = useT(),
    api = useApi();
  const { node } = nodeRoute.useLoaderData();
  const { hash } = paymentRoute.useParams();
  const payment = useQuery({
    queryKey: ['payment', node.id, hash],
    queryFn: () => api.call('payment', { params: { nodeId: node.id, paymentHash: hash } }),
    retry: (count, error) => !(error instanceof ApiError && error.code === 'not_found') && count < 2,
  });
  const p = payment.data;
  return (
    <div className="flex max-w-[720px] flex-col gap-6">
      <PageHeader title={tr.t('payments.paymentTitle')} />
      {payment.error instanceof ApiError && payment.error.code === 'not_found' ? (
        <Missing text={tr.t('payments.noPayment')} tab="sent" />
      ) : payment.error ? (
        <ErrorNote error={payment.error} onRetry={() => void payment.refetch()} />
      ) : !p ? (
        <p>{tr.t('app.loading')}</p>
      ) : (
        <Card>
          <div className="flex flex-col gap-4" data-testid="payment-detail" data-state={p.status}>
            <div className="flex flex-wrap items-center gap-3">
              <HistoryStatus status={p.status} />
              <ChainBadge identity={node.chainIdentity} />
            </div>
            {p.status === 'pending' ? <p className="text-sm">{tr.t('payments.pendingHelp')}</p> : null}
            <Rows
              rows={[
                [tr.t('payments.amount'), p.amount ? <Amount msat={p.amount} cost /> : undefined],
                [tr.t('payments.amountSent'), p.amountSent ? <Amount msat={p.amountSent} cost /> : undefined],
                [tr.t('payments.fee'), p.fee ? <Amount msat={p.fee} cost /> : undefined],
                [tr.t('payments.destination'), p.destination ? <IdValue value={p.destination} full /> : undefined],
                [tr.t('payments.hash'), <IdValue key="hash" value={p.paymentHash} full />],
                [tr.t('payments.created'), p.createdAt ? <When iso={p.createdAt} /> : undefined],
                [tr.t('payments.completed'), p.completedAt ? <When iso={p.completedAt} /> : undefined],
                [tr.t('payments.parts'), p.parts?.toString()],
                [tr.t('payments.label'), p.label],
              ]}
            />
            <p className="text-sm text-muted">{tr.t('payments.noPreimage')}</p>
          </div>
        </Card>
      )}
      <BackLink tab="sent" />
    </div>
  );
}

export function InvoiceScreen() {
  const tr = useT(),
    api = useApi(),
    copyLabels = useCopyLabels();
  const { node } = nodeRoute.useLoaderData();
  const { hash } = invoiceRoute.useParams();
  const invoice = useQuery({
    queryKey: ['invoice', node.id, hash],
    queryFn: () => api.call('invoice', { params: { nodeId: node.id, paymentHash: hash } }),
    retry: (count, error) => !(error instanceof ApiError && error.code === 'not_found') && count < 2,
  });
  const i = invoice.data;
  return (
    <div className="flex max-w-[720px] flex-col gap-6">
      <PageHeader title={tr.t('payments.invoiceTitle')} />
      {invoice.error instanceof ApiError && invoice.error.code === 'not_found' ? (
        <Missing text={tr.t('payments.noInvoice')} tab="received" />
      ) : invoice.error && !i ? (
        <ErrorNote error={invoice.error} onRetry={() => void invoice.refetch()} />
      ) : !i ? (
        <p>{tr.t('app.loading')}</p>
      ) : (
        <Card>
          <div className="flex flex-col gap-4">
            <div
              className="flex flex-wrap items-center gap-3"
              role="status"
              data-testid="invoice-status"
              data-state={i.status}
            >
              <HistoryStatus status={i.status} />
              <ChainBadge identity={node.chainIdentity} />
              {i.status === 'paid' ? (
                <span className="font-semibold text-success">
                  {tr.t('payments.receivedLabel')}{' '}
                  {i.amountReceived ? <Amount msat={i.amountReceived} testId="invoice-received" /> : null}
                </span>
              ) : null}
            </div>
            {invoice.error ? <ErrorNote error={invoice.error} onRetry={() => void invoice.refetch()} /> : null}
            {i.status === 'unpaid' ? (
              <>
                <p className="text-2xl font-semibold">
                  {i.amount ? <Amount msat={i.amount} testId="invoice-amount" /> : null}
                </p>
                <QrBlock
                  value={i.bolt11}
                  label={tr.t('payments.invoiceQr')}
                  copyLabels={copyLabels}
                  textTestId="bolt11"
                />
                <p className="text-sm text-muted">{tr.t('payments.waiting')}</p>
              </>
            ) : null}
            <Rows
              rows={[
                [tr.t('payments.amount'), i.amount ? <Amount msat={i.amount} /> : undefined],
                [tr.t('payments.description'), i.description],
                [tr.t('payments.hash'), <IdValue key="hash" value={i.paymentHash} full />],
                [tr.t('payments.created'), i.createdAt ? <When iso={i.createdAt} /> : undefined],
                [tr.t('payments.expires'), <When key="expires" iso={i.expiresAt} />],
                [tr.t('payments.paidAt'), i.paidAt ? <When iso={i.paidAt} /> : undefined],
                [tr.t('payments.label'), i.label],
              ]}
            />
          </div>
        </Card>
      )}
      <BackLink tab="received" />
    </div>
  );
}
