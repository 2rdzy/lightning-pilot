// Pay (U8): paste or scan anything payable → decoded preview → confirm (style guide §6). The input is classified in
// the browser (classify.ts); a Lightning invoice, pasted or inside a bitcoin: URI, goes to the server's preview,
// which decodes it again and applies the chain, expiry and limits. The payment is sent only with the preview's
// single-use token and an idempotency key made once per preview: a retry after a lost reply sends the same body
// with the same key, so it can never pay twice. A ?request= link only prefills the form; it leaves the browser
// history at once and the screen says where the request came from (style guide §7).
import type { PaymentPreviewResponse } from '@lightning-pilot/core';
import { Button, ErrorState, Field, PageHeader, PreviewPanel, QrImageInput, StepUpDialog } from '@lightning-pilot/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { ApiError, newIdempotencyKey } from '../../api/client.ts';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodeRoute, payRoute } from '../../app/router.tsx';
import { formatCost, formatDateTime, formatSats, parseSatsInput } from '../../i18n/format.ts';
import { Amount, ChainBadge, Card, ErrorNote, IdValue } from '../../shell/parts.tsx';
import { refreshNodeReads } from '../node/queries.ts';
import { classifyRequest, type Classified } from './classify.ts';

type Preview = z.infer<typeof PaymentPreviewResponse>;
interface Confirmation {
  data: Preview;
  key: string;
  // What the bitcoin: URI said about itself (untrusted text), when the invoice came from one.
  label?: string;
  message?: string;
}

export function PayScreen() {
  const { node } = nodeRoute.useLoaderData();
  // A new node starts a new form: no preview, password or acknowledgement carries over to another node.
  return <Pay key={node.id} />;
}

// Errors the server answers before anything was sent: editing and previewing again is safe after them.
const EDITABLE = [
  'confirmation_invalid',
  'step_up_required',
  'chain_refused',
  'chain_waiting',
  'capability_missing',
  'limit_exceeded',
  'fee_cap_exceeded',
  'validation_failed',
];

// The server refuses a payment request with `validation_failed` and the decoder's reason (implementation notes §12
// item 2); show the reason's own message.
export function PayError({ error }: { error: unknown }) {
  const tr = useT();
  const reason =
    error instanceof ApiError && error.code === 'validation_failed'
      ? (error.details as { reason?: unknown } | undefined)?.reason
      : undefined;
  if (typeof reason === 'string' && tr.has(`errors.decode.${reason}`)) {
    return (
      <ErrorState
        message={tr.t(`errors.decode.${reason}`)}
        requestId={
          error instanceof ApiError && error.requestId
            ? tr.t('common.requestId', { requestId: error.requestId })
            : undefined
        }
        retryLabel={tr.t('common.retry')}
      />
    );
  }
  if (error instanceof ApiError && error.code === 'idempotency_conflict')
    return <ErrorState message={tr.t('pay.stillRunning')} retryLabel={tr.t('common.retry')} />;
  return <ErrorNote error={error} />;
}

function Pay() {
  const tr = useT();
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { node } = nodeRoute.useLoaderData();
  const search = payRoute.useSearch();
  const [request, setRequest] = useState('');
  const [amount, setAmount] = useState('');
  const [maxFee, setMaxFee] = useState('');
  const [fromLink, setFromLink] = useState(false);
  const [handoff, setHandoff] = useState<Classified>();
  const [scanFailed, setScanFailed] = useState(false);
  const [inputError, setInputError] = useState<string>();
  const [preview, setPreview] = useState<Confirmation>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  // A step-up answer that arrives after the dialog was closed (or the screen left) must not pay.
  const activeGrant = useRef(false);
  useEffect(
    () => () => {
      activeGrant.current = false;
    },
    [],
  );

  // Read ?request= once, then replace the history entry with the plain route.
  useEffect(() => {
    if (search.request === undefined) return;
    setRequest(search.request);
    setFromLink(true);
    void navigate({ to: '/n/$node/pay', params: { node: node.id }, search: {}, replace: true });
  }, [search.request, navigate, node.id]);

  const budget = useQuery({
    queryKey: ['spend-policy', node.id],
    queryFn: () => api.call('spendPolicy', { params: { nodeId: node.id } }),
    enabled: preview !== undefined,
  });

  const optionalSats = (text: string): string | undefined => {
    if (!text.trim()) return undefined;
    const value = parseSatsInput(text, tr.locale);
    if (value === undefined) throw new Error(tr.t('pay.invalidAmount'));
    return value.toString();
  };

  const makePreview = useMutation({
    mutationFn: (invoice: { bolt11: string; label?: string; message?: string }) => {
      const amountMsat = optionalSats(amount),
        feeMsat = optionalSats(maxFee);
      return api
        .call('previewPayment', {
          userActivity: true,
          params: { nodeId: node.id },
          body: {
            request: invoice.bolt11,
            ...(amountMsat === undefined ? {} : { amount: amountMsat }),
            ...(feeMsat === undefined ? {} : { maxFee: feeMsat }),
          },
        })
        .then((data) => ({ data, invoice }));
    },
    onSuccess: ({ data, invoice }) => {
      setPreview({
        data,
        key: newIdempotencyKey(),
        ...(invoice.label ? { label: invoice.label } : {}),
        ...(invoice.message ? { message: invoice.message } : {}),
      });
      setAcknowledged(false);
      setAttempted(false);
      setAuthorized(false);
    },
  });

  const execute = useMutation({
    // The body is fixed once the first attempt may have left the browser: retries resend exactly it.
    mutationFn: (record: { confirmation: Confirmation; acknowledgeDuplicate: boolean }) =>
      api.call('executePayment', {
        userActivity: true,
        params: { nodeId: node.id },
        body: {
          confirmationToken: record.confirmation.data.confirmationToken,
          acknowledgeDuplicate: record.acknowledgeDuplicate,
        },
        idempotencyKey: record.confirmation.key,
      }),
    onSettled: () => refreshNodeReads(queryClient),
  });
  const frozenAck = useRef(false);
  const send = (confirmation: Confirmation) => {
    if (!attempted) frozenAck.current = acknowledged;
    setAttempted(true);
    execute.mutate({ confirmation, acknowledgeDuplicate: frozenAck.current });
  };

  const grant = useMutation({
    mutationFn: (password: string) =>
      api.call('stepUp', { userActivity: true, body: { password, strength: 'password' } }),
  });

  const startOver = () => {
    setPreview(undefined);
    setFromLink(false);
    setHandoff(undefined);
    makePreview.reset();
    execute.reset();
    grant.reset();
    setAuthorized(false);
    setAcknowledged(false);
    setAttempted(false);
    setRequest('');
    setAmount('');
    setMaxFee('');
  };

  const submit = () => {
    setInputError(undefined);
    setHandoff(undefined);
    makePreview.reset();
    if (!request.trim()) {
      setInputError(tr.t('pay.requestRequired'));
      return;
    }
    try {
      optionalSats(amount);
      optionalSats(maxFee);
    } catch (error) {
      setInputError((error as Error).message);
      return;
    }
    const classified = classifyRequest(request, node.chain, node.network);
    if (classified.kind === 'invoice') makePreview.mutate(classified);
    else setHandoff(classified);
  };

  const failed = execute.error instanceof ApiError && execute.error.code === 'payment_failed';
  const result = execute.data;
  const locked = execute.isPending || grant.isPending;

  if (preview && (result || failed)) {
    const details = execute.error instanceof ApiError ? execute.error.details : undefined;
    const failedIntent =
      details && typeof details === 'object' && 'intentId' in details && typeof details.intentId === 'string'
        ? details.intentId
        : undefined;
    return (
      <div className="flex max-w-[640px] flex-col gap-6">
        <PageHeader title={tr.t('pay.title')} />
        <Card>
          <div
            role="status"
            data-testid="payment-outcome"
            data-state={failed ? 'failed' : result?.state}
            className="flex flex-col gap-3"
          >
            {result?.state === 'succeeded' ? (
              <>
                <p className="text-xl font-semibold text-success">
                  {tr.t('pay.succeeded', { amount: formatCost(BigInt(result.amount), tr.locale) })}
                </p>
                {result.fee ? (
                  <p className="text-sm text-muted">
                    {tr.t('pay.fee', { amount: formatCost(BigInt(result.fee), tr.locale) })}
                  </p>
                ) : null}
                {result.preimage ? (
                  <div className="text-sm">
                    <p className="text-muted">{tr.t('pay.preimage')}</p>
                    <IdValue value={result.preimage} full testId="payment-preimage" />
                    <p className="mt-1 text-muted">{tr.t('pay.preimageHelp')}</p>
                  </div>
                ) : null}
              </>
            ) : result?.state === 'unknown' ? (
              <>
                <p className="rounded-control border-l-4 border-warning pl-3 font-medium">{tr.t('pay.unknown')}</p>
                <p className="text-sm">{tr.t('pay.unknownHelp')}</p>
                {execute.error ? <PayError error={execute.error} /> : null}
                <Button onClick={() => send(preview)} disabled={locked}>
                  {execute.isPending ? tr.t('pay.checking') : tr.t('pay.checkAgain')}
                </Button>
              </>
            ) : (
              <p className="font-medium text-danger">{tr.t('pay.failed')}</p>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {result?.intentId || failedIntent ? (
                <>
                  <dt className="text-muted">{tr.t('pay.intent')}</dt>
                  <dd>
                    <IdValue value={result?.intentId ?? failedIntent ?? ''} />
                  </dd>
                </>
              ) : null}
              <dt className="text-muted">{tr.t('pay.paymentHash')}</dt>
              <dd>
                <IdValue value={preview.data.decoded.paymentHash} />
              </dd>
            </dl>
            <Link
              className="inline-flex min-h-11 items-center text-brand-strong underline"
              to="/n/$node/payments/$hash"
              params={{ node: node.id, hash: preview.data.decoded.paymentHash }}
              data-testid="payment-detail-link"
            >
              {tr.t('pay.showPayment')}
            </Link>
          </div>
        </Card>
        <Button className="self-start" onClick={startOver} disabled={locked}>
          {tr.t('pay.another')}
        </Button>
      </div>
    );
  }

  if (preview) {
    const p = preview.data;
    const needsStepUp =
      (p.stepUpRequired && !authorized) ||
      (execute.error instanceof ApiError && execute.error.code === 'step_up_required');
    const mayEdit =
      !locked && (!execute.error || (execute.error instanceof ApiError && EDITABLE.includes(execute.error.code)));
    const act = () => {
      if (needsStepUp) {
        activeGrant.current = true;
        grant.reset();
        setStepUp(true);
      } else send(preview);
    };
    return (
      <div className="flex max-w-[640px] flex-col gap-6">
        <PageHeader title={tr.t('pay.title')} />
        <PreviewPanel
          title={tr.t('pay.previewTitle')}
          chain={<ChainBadge identity={p.chainIdentity} />}
          notice={fromLink ? <Notice text={tr.t('pay.fromLink')} /> : undefined}
          rows={[
            { label: tr.t('pay.amount'), value: <Amount msat={p.cost.amount} testId="preview-amount" cost /> },
            { label: tr.t('pay.maxFee'), value: <Amount msat={p.cost.maxFee} cost /> },
            { label: tr.t('pay.total'), value: <Amount msat={p.cost.total} cost />, emphasis: true },
            ...(p.payee
              ? [{ label: tr.t('pay.payee'), value: <IdValue value={p.payee} testId="preview-payee" /> }]
              : []),
            ...(p.description
              ? [{ label: tr.t('pay.description'), value: <span className="break-all">{p.description}</span> }]
              : []),
            ...(preview.label
              ? [{ label: tr.t('pay.uriLabel'), value: <span className="break-all">{preview.label}</span> }]
              : []),
            ...(preview.message
              ? [{ label: tr.t('pay.uriMessage'), value: <span className="break-all">{preview.message}</span> }]
              : []),
            { label: tr.t('pay.network'), value: p.decoded.network },
            { label: tr.t('pay.paymentHash'), value: <IdValue value={p.decoded.paymentHash} /> },
            {
              label: tr.t('pay.invoiceExpires'),
              value: (
                <time dateTime={p.decoded.expiresAt} title={p.decoded.expiresAt}>
                  {formatDateTime(p.decoded.expiresAt, tr.locale)}
                </time>
              ),
            },
          ]}
          warnings={[
            ...(p.feeOverride ? [tr.t('pay.feeOverride')] : []),
            ...(p.duplicateWarning ? [tr.t('pay.duplicateWarning')] : []),
          ]}
          confirmLabel={
            execute.isPending
              ? tr.t('pay.sending')
              : tr.t('pay.confirm', { amount: formatCost(BigInt(p.cost.total), tr.locale) })
          }
          confirmDisabled={locked || (p.duplicateWarning && !acknowledged)}
          onConfirm={act}
        >
          <p className="text-sm text-muted">{p.scope}</p>
          <p className="text-sm text-muted">
            {tr.t('pay.previewExpires', { time: formatDateTime(p.expiresAt, tr.locale) })}
          </p>
          {budget.error ? (
            <ErrorNote error={budget.error} onRetry={() => void budget.refetch()} />
          ) : budget.data ? (
            <p className="text-sm" data-testid="preview-remaining">
              {tr.t('pay.remaining')}:{' '}
              {budget.data.policy === null ? (
                tr.t('pay.noLimits')
              ) : budget.data.remainingMsat === null ? (
                tr.t('pay.unlimited')
              ) : (
                <Amount msat={budget.data.remainingMsat} cost />
              )}
            </p>
          ) : null}
          {p.duplicateWarning ? (
            <Field label={tr.t('pay.duplicate')} htmlFor="pay-duplicate">
              <input
                id="pay-duplicate"
                type="checkbox"
                className="size-[24px]"
                disabled={attempted}
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
            </Field>
          ) : null}
          {execute.error ? <PayError error={execute.error} /> : null}
          {attempted && execute.error && !mayEdit ? <p className="text-sm">{tr.t('pay.retrySame')}</p> : null}
          <Button
            className="self-start"
            disabled={!mayEdit}
            onClick={() => {
              setPreview(undefined);
              execute.reset();
              makePreview.reset();
              setAuthorized(false);
              setAttempted(false);
            }}
          >
            {tr.t('pay.edit')}
          </Button>
        </PreviewPanel>
        {stepUp ? (
          <StepUpDialog
            open
            onOpenChange={(open) => {
              activeGrant.current = open;
              setStepUp(open);
            }}
            reason={tr.t(p.feeOverride ? 'pay.stepUpFee' : 'pay.stepUpReason')}
            needsTotp={false}
            labels={{
              title: tr.t('stepUp.title'),
              password: tr.t('stepUp.password'),
              totp: tr.t('stepUp.totp'),
              submit: tr.t('stepUp.submit'),
              cancel: tr.t('common.cancel'),
              close: tr.t('common.close'),
            }}
            pending={grant.isPending}
            error={grant.error ? <ErrorNote error={grant.error} /> : undefined}
            onSubmit={({ password }) =>
              grant.mutate(password, {
                onSuccess: () => {
                  if (!activeGrant.current) return;
                  activeGrant.current = false;
                  setAuthorized(true);
                  setStepUp(false);
                  send(preview);
                },
              })
            }
          />
        ) : null}
      </div>
    );
  }

  const parsedAmount = amount.trim() ? parseSatsInput(amount, tr.locale) : undefined;
  return (
    <div className="flex max-w-[640px] flex-col gap-6">
      <PageHeader title={tr.t('pay.title')} />
      {fromLink ? <Notice text={tr.t('pay.fromLink')} /> : null}
      <form
        className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <fieldset disabled={makePreview.isPending} className="contents">
          <Field label={tr.t('pay.request')} htmlFor="request" hint={tr.t('pay.requestHint')}>
            <textarea
              id="request"
              rows={4}
              className="input font-mono text-sm break-all"
              spellCheck={false}
              autoComplete="off"
              maxLength={4096}
              value={request}
              onChange={(e) => {
                setRequest(e.target.value);
                setHandoff(undefined);
              }}
            />
          </Field>
          <div className="flex flex-col gap-1">
            <QrImageInput
              label={tr.t('pay.scan')}
              busyLabel={tr.t('pay.scanning')}
              onDecoded={(text) => {
                setScanFailed(false);
                setHandoff(undefined);
                setRequest(text.slice(0, 4096));
              }}
              onNotFound={() => setScanFailed(true)}
            />
            <p className="text-xs text-muted">{tr.t('pay.scanHelp')}</p>
            {scanFailed ? (
              <p role="alert" className="text-sm text-danger">
                {tr.t('pay.scanFailed')}
              </p>
            ) : null}
          </div>
          <Field
            label={tr.t('pay.optionalAmount')}
            htmlFor="pay-amount"
            {...(parsedAmount !== undefined
              ? { hint: tr.t('pay.amountReadBack', { amount: formatSats(parsedAmount, tr.locale) }) }
              : {})}
          >
            <input
              id="pay-amount"
              className="input tabular-nums"
              inputMode="numeric"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label={tr.t('pay.optionalFee')} htmlFor="pay-fee">
            <input
              id="pay-fee"
              className="input tabular-nums"
              inputMode="numeric"
              autoComplete="off"
              value={maxFee}
              onChange={(e) => setMaxFee(e.target.value)}
            />
          </Field>
          {inputError ? (
            <p role="alert" className="text-sm text-danger" data-testid="error">
              {inputError}
            </p>
          ) : null}
          {handoff ? <Handoff classified={handoff} nodeId={node.id} /> : null}
          {makePreview.error ? <PayError error={makePreview.error} /> : null}
          <Button type="submit" variant="primary" className="self-start">
            {makePreview.isPending ? tr.t('pay.previewing') : tr.t('pay.preview')}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}

// What the screen says about input that is not a Lightning invoice.
function Handoff({ classified, nodeId }: { classified: Classified; nodeId: string }) {
  const tr = useT();
  const text =
    classified.kind === 'onchain'
      ? tr.t('pay.handoff.onchain')
      : classified.kind === 'node'
        ? tr.t('pay.handoff.node')
        : classified.kind === 'unsupported'
          ? tr.t('pay.handoff.unsupported')
          : classified.kind === 'invalid'
            ? tr.has(`errors.decode.${classified.reason}`)
              ? tr.t(`errors.decode.${classified.reason}`)
              : tr.t('errors.validation_failed')
            : tr.t('pay.handoff.unknown');
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-control border border-warning p-3 text-sm"
      data-testid="pay-handoff"
    >
      <p>{text}</p>
      {classified.kind === 'onchain' ? (
        <Link
          className="inline-flex min-h-11 items-center text-brand-strong underline"
          to="/n/$node/onchain/send"
          params={{ node: nodeId }}
          search={{
            address: classified.address,
            ...(classified.amountSats === undefined ? {} : { amount: classified.amountSats }),
          }}
          data-testid="pay-handoff-onchain"
        >
          {tr.t('pay.handoff.send')}
        </Link>
      ) : null}
      {classified.kind === 'node' ? (
        <Link
          className="inline-flex min-h-11 items-center text-brand-strong underline"
          to="/n/$node/peers/connect"
          params={{ node: nodeId }}
          search={{ peer: classified.uri.split('@')[0]?.toLowerCase() }}
        >
          {tr.t('pay.handoff.connect')}
        </Link>
      ) : null}
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <p role="note" className="rounded-card border border-info bg-surface p-3 text-sm" data-testid="from-link">
      {text}
    </p>
  );
}
