// Pay (walking skeleton): paste → preview → confirm (style guide §6). The confirm button names the amount; the
// payment is sent only with the single-use confirmation token of the preview and an idempotency key made once per
// preview, so a retry after a lost reply can never pay twice. A ?request= link only prefills the form: it is
// removed from the browser history at once and the screen says where the request came from (style guide §7).
import type { PaymentPreviewResponse, PaymentResultResponse } from '@lightning-pilot/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ApiError, newIdempotencyKey } from '../../api/client.ts';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { Amount, Card, ChainBadge, ErrorNote, Field } from '../../app/parts.tsx';
import { nodeRoute, payRoute } from '../../app/router.tsx';
import { formatCost, formatDateTime, shortId, parseSatsInput } from '../../i18n/format.ts';

type Preview = z.infer<typeof PaymentPreviewResponse>;
type Result = z.infer<typeof PaymentResultResponse>;

export function PayScreen() {
  const tr = useT();
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { node } = nodeRoute.useLoaderData();
  const search = payRoute.useSearch();
  const [fromLink, setFromLink] = useState(false);
  const [preview, setPreview] = useState<{ data: Preview; key: string } | undefined>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const form = useForm<{ request: string; amount: string; maxFee: string }>({
    defaultValues: { request: '', amount: '', maxFee: '' },
  });

  // Read ?request= once, then replace the history entry with the plain route.
  useEffect(() => {
    if (search.request === undefined) return;
    form.setValue('request', search.request);
    setFromLink(true);
    void navigate({ to: '/n/$node/pay', params: { node: node.id }, search: {}, replace: true });
  }, [search.request, form, navigate, node.id]);

  const previewMutation = useMutation({
    mutationFn: (values: { request: string; amount: string; maxFee: string }) => {
      const optional = (value: string) => {
        if (!value.trim()) return undefined;
        const amount = parseSatsInput(value, tr.locale);
        if (amount === undefined) throw new Error(tr.t('pay.invalidAmount'));
        return amount.toString();
      };
      const amount = optional(values.amount),
        maxFee = optional(values.maxFee);
      return api.call('previewPayment', {
        userActivity: true,
        params: { nodeId: node.id },
        body: {
          request: values.request.trim(),
          ...(amount === undefined ? {} : { amount }),
          ...(maxFee === undefined ? {} : { maxFee }),
        },
      });
    },
    onSuccess: (data) => {
      setPreview({ data, key: newIdempotencyKey() });
      setAcknowledged(false);
      setAuthorized(false);
    },
  });
  const execute = useMutation({
    mutationFn: async (p: { data: Preview; key: string }) => {
      if (password) {
        const proof = password;
        setPassword('');
        await api.call('stepUp', { userActivity: true, body: { password: proof, strength: 'password' } });
        setAuthorized(true);
      }
      return api.call('executePayment', {
        userActivity: true,
        params: { nodeId: node.id },
        body: { confirmationToken: p.data.confirmationToken, acknowledgeDuplicate: acknowledged },
        idempotencyKey: p.key,
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'step_up_required') setAuthorized(false);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['balances', node.id] }),
  });

  const startOver = () => {
    setPreview(undefined);
    setFromLink(false);
    previewMutation.reset();
    execute.reset();
    setPassword('');
    setAuthorized(false);
    setAcknowledged(false);
    form.reset({ request: '', amount: '', maxFee: '' });
  };

  if (execute.data || (execute.error instanceof ApiError && execute.error.code === 'payment_failed')) {
    return <Outcome result={execute.data} onAgain={startOver} />;
  }

  if (preview) {
    const p = preview.data;
    const needsStepUp =
      !authorized &&
      (p.stepUpRequired || (execute.error instanceof ApiError && execute.error.code === 'step_up_required'));
    const amountText = formatCost(BigInt(p.cost.amount), tr.locale);
    return (
      <div className="flex max-w-[640px] flex-col gap-6">
        <h1 className="text-2xl font-semibold">{tr.t('pay.title')}</h1>
        {fromLink ? <Notice text={tr.t('pay.fromLink')} /> : null}
        <Card title={tr.t('pay.previewTitle')}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2" data-testid="preview">
            <dt className="text-muted">{tr.t('pay.amount')}</dt>
            <dd className="text-right">
              <Amount msat={p.cost.amount} testId="preview-amount" cost />
            </dd>
            <dt className="text-muted">{tr.t('pay.maxFee')}</dt>
            <dd className="text-right">
              <Amount msat={p.cost.maxFee} cost />
            </dd>
            <dt className="font-medium">{tr.t('pay.total')}</dt>
            <dd className="text-right font-semibold">
              <Amount msat={p.cost.total} cost />
            </dd>
            <dt className="text-muted">{tr.t('pay.network')}</dt>
            <dd className="flex items-center justify-end gap-2">
              <ChainBadge identity={p.chainIdentity} />
              <span>{p.decoded.network}</span>
            </dd>
            <dt className="text-muted">{tr.t('pay.paymentHash')}</dt>
            <dd className="text-right font-mono text-sm" title={p.decoded.paymentHash}>
              {shortId(p.decoded.paymentHash)}
            </dd>
            <dt className="text-muted">{tr.t('pay.invoiceExpires')}</dt>
            <dd className="text-right">{formatDateTime(p.decoded.expiresAt, tr.locale)}</dd>
          </dl>
          <p className="text-muted mt-3 text-sm">
            {tr.t('pay.previewExpires', { time: formatDateTime(p.expiresAt, tr.locale) })}
          </p>
        </Card>
        <p role="note">{p.scope}</p>
        {p.payee ? (
          <p className="break-all">
            {tr.t('pay.payee')}: {p.payee}
          </p>
        ) : null}
        {p.description ? <p className="break-all">{p.description}</p> : null}
        {p.feeOverride ? <Notice text={tr.t('pay.feeOverride')} /> : null}
        {p.duplicateWarning ? (
          <label>
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />{' '}
            {tr.t('pay.duplicate')}
          </label>
        ) : null}
        {needsStepUp ? (
          <Field label={tr.t('pay.password')} htmlFor="spend-password">
            <input
              id="spend-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        ) : null}
        {execute.error ? <ErrorNote error={execute.error} /> : null}
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={execute.isPending || (p.duplicateWarning && !acknowledged) || (needsStepUp && !password)}
            onClick={() => execute.mutate(preview)}
          >
            {execute.isPending ? tr.t('pay.sending') : tr.t('pay.confirm', { amount: amountText })}
          </button>
          <button type="button" className="btn-secondary" onClick={startOver} disabled={execute.isPending}>
            {tr.t('pay.cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-6">
      <h1 className="text-2xl font-semibold">{tr.t('pay.title')}</h1>
      {fromLink ? <Notice text={tr.t('pay.fromLink')} /> : null}
      <form
        className="rounded-card border-border bg-surface flex flex-col gap-4 border p-4"
        noValidate
        onSubmit={form.handleSubmit((v) => previewMutation.mutate(v))}
      >
        <Field
          label={tr.t('pay.request')}
          htmlFor="request"
          error={form.formState.errors.request ? tr.t('pay.requestRequired') : undefined}
        >
          <textarea
            id="request"
            rows={4}
            className="input font-mono text-sm break-all"
            spellCheck={false}
            autoComplete="off"
            {...form.register('request', { validate: (v) => v.trim().length > 0 })}
          />
        </Field>
        <Field label={tr.t('pay.optionalAmount')} htmlFor="pay-amount">
          <input id="pay-amount" className="input" inputMode="numeric" {...form.register('amount')} />
        </Field>
        <Field label={tr.t('pay.optionalFee')} htmlFor="pay-fee">
          <input id="pay-fee" className="input" inputMode="numeric" {...form.register('maxFee')} />
        </Field>
        {previewMutation.error ? <ErrorNote error={previewMutation.error} /> : null}
        <button type="submit" className="btn-primary self-start" disabled={previewMutation.isPending}>
          {tr.t('pay.preview')}
        </button>
      </form>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <p role="note" className="rounded-card border-info bg-surface border p-3 text-sm" data-testid="from-link">
      {text}
    </p>
  );
}

function Outcome({ result, onAgain }: { result: Result | undefined; onAgain: () => void }) {
  const tr = useT();
  return (
    <div className="flex max-w-[640px] flex-col gap-6">
      <h1 className="text-2xl font-semibold">{tr.t('pay.title')}</h1>
      <Card title={tr.t('pay.title')}>
        <div role="status" data-testid="payment-outcome" data-state={result?.state ?? 'failed'}>
          {result?.state === 'succeeded' ? (
            <div className="flex flex-col gap-2">
              <p className="text-success text-xl font-semibold">
                {tr.t('pay.succeeded', { amount: formatCost(BigInt(result.amount), tr.locale) })}
              </p>
              {result.fee ? (
                <p className="text-muted text-sm">
                  {tr.t('pay.fee', { amount: formatCost(BigInt(result.fee), tr.locale) })}
                </p>
              ) : null}
              {result.preimage ? (
                <p className="text-sm">
                  <span className="text-muted">{tr.t('pay.preimage')}: </span>
                  <span className="font-mono break-all">{result.preimage}</span>
                </p>
              ) : null}
            </div>
          ) : result?.state === 'unknown' ? (
            <p className="border-warning rounded-control border-l-4 pl-3 font-medium">{tr.t('pay.unknown')}</p>
          ) : (
            <p className="text-danger font-medium">{tr.t('pay.failed')}</p>
          )}
        </div>
      </Card>
      <button type="button" className="btn-secondary self-start" onClick={onAgain}>
        {tr.t('pay.another')}
      </button>
    </div>
  );
}
