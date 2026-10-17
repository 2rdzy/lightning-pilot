// On-chain send (U6, B2, F3; route /n/:node/onchain/send, a dialog over the wallet): address, amount in whole sats and
// a fee rate from the node's estimates → the server's preview → a second confirmation that names the coin and the
// chain (an address does not say which chain it belongs to, style guide §2) → password step-up when the preview asks
// for it → execute. The screen does no fee arithmetic: the maximum fee, the fee rate and the step-up come from the
// preview. One idempotency key per preview; once an attempt may have left the browser, retries resend the same body
// with the same token and key, so the coins can never be sent twice. A link may prefill the form; it never sends.
import type { OnchainPreviewResponse } from '@lightning-pilot/core';
import { Button, Dialog, Field, PreviewPanel, StepUpDialog } from '@lightning-pilot/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { ApiError, newIdempotencyKey } from '../../api/client.ts';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodeRoute, onchainSendRoute } from '../../app/router.tsx';
import { COIN, formatCoins, formatCost, formatDateTime, formatInteger, parseSatsInput } from '../../i18n/format.ts';
import { Amount, ChainBadge, ErrorNote, IdValue } from '../../shell/parts.tsx';
import { ActionFrame, ActionUnavailable, useActionAllowed } from '../channels/parts.tsx';
import { refreshNodeReads } from '../node/queries.ts';
import { feesQuery, presetRate } from './data.ts';
import { ONCHAIN_DEFAULTS } from './OnchainScreen.tsx';

type Preview = z.infer<typeof OnchainPreviewResponse>;
interface Confirmation {
  data: Preview;
  key: string;
}
type FeeChoice = 'fast' | 'normal' | 'slow' | 'custom';

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
  'setup_required',
];

function reasonOf(error: unknown): string | undefined {
  const details = error instanceof ApiError ? (error.details as { reason?: unknown } | undefined) : undefined;
  return typeof details?.reason === 'string' ? details.reason : undefined;
}

// The server's refusal, with the screen's own text where the generic one would not say what to do.
function SendError({ error }: { error: unknown }) {
  const tr = useT();
  const reason = reasonOf(error);
  if (error instanceof ApiError) {
    const key =
      error.code === 'setup_required' && reason
        ? `onchain.setup.${reason}`
        : error.code === 'validation_failed' && reason
          ? tr.has(`onchain.decode.${reason}`)
            ? `onchain.decode.${reason}`
            : `errors.decode.${reason}`
          : error.code === 'fee_cap_exceeded'
            ? 'onchain.feeCapPreview'
            : error.code === 'idempotency_conflict'
              ? 'onchain.stillRunning'
              : undefined;
    if (key && tr.has(key))
      return (
        <p role="alert" className="rounded-control border border-danger p-3 text-sm" data-testid="send-error">
          {tr.t(key)}
        </p>
      );
  }
  return <ErrorNote error={error} />;
}

export function SendScreen() {
  const { node } = nodeRoute.useLoaderData();
  // A new node starts a new form: no preview, password or acknowledgement carries over to another node.
  return <Send key={node.id} />;
}

function Send() {
  const api = useApi(),
    tr = useT(),
    client = useQueryClient(),
    navigate = useNavigate();
  const { node } = nodeRoute.useLoaderData();
  const search = onchainSendRoute.useSearch();
  const allowed = useActionAllowed('onchain.send');
  const fees = useQuery(feesQuery(api, node.id));
  const budget = useQuery({
    queryKey: ['spend-policy', node.id],
    queryFn: () => api.call('spendPolicy', { params: { nodeId: node.id } }),
  });
  const [address, setAddress] = useState(''),
    [amount, setAmount] = useState(''),
    [fee, setFee] = useState<FeeChoice>('normal'),
    [customRate, setCustomRate] = useState(''),
    [fromLink, setFromLink] = useState(false),
    [inputError, setInputError] = useState<string>();
  const [preview, setPreview] = useState<Confirmation>(),
    [acknowledged, setAcknowledged] = useState(false),
    [attempted, setAttempted] = useState(false),
    [authorized, setAuthorized] = useState(false),
    [confirming, setConfirming] = useState(false),
    [stepUp, setStepUp] = useState(false);
  // A step-up answer that arrives after the dialog was closed (or the screen left) must not send.
  const activeGrant = useRef(false);
  useEffect(
    () => () => {
      activeGrant.current = false;
    },
    [],
  );

  // Read a prefill link once, then replace the history entry with the plain route (style guide §7).
  useEffect(() => {
    if (search.address === undefined && search.amount === undefined) return;
    if (search.address !== undefined) setAddress(search.address);
    if (search.amount !== undefined) setAmount(search.amount);
    setFromLink(true);
    void navigate({ to: '/n/$node/onchain/send', params: { node: node.id }, search: {}, replace: true });
  }, [search.address, search.amount, navigate, node.id]);

  const rates = fees.data?.rates;
  const presets: Record<Exclude<FeeChoice, 'custom'>, string | undefined> = {
    fast: presetRate(rates?.fastest),
    normal: presetRate(rates?.halfHour),
    slow: presetRate(rates?.economy),
  };

  const makePreview = useMutation({
    mutationFn: (body: { address: string; amount: string; feeRate?: string }) =>
      api.call('previewOnchain', { params: { nodeId: node.id }, userActivity: true, body }),
    onSuccess: (data) => {
      setPreview({ data, key: newIdempotencyKey() });
      setAcknowledged(false);
      setAttempted(false);
      setAuthorized(false);
    },
  });
  const execute = useMutation({
    // The body is fixed once the first attempt may have left the browser: retries resend exactly it.
    mutationFn: (record: { confirmation: Confirmation; acknowledgeDuplicate: boolean }) =>
      api.call('executeOnchain', {
        params: { nodeId: node.id },
        userActivity: true,
        body: {
          confirmationToken: record.confirmation.data.confirmationToken,
          acknowledgeDuplicate: record.acknowledgeDuplicate,
        },
        idempotencyKey: record.confirmation.key,
      }),
    onSettled: () => refreshNodeReads(client),
  });
  const frozenAck = useRef(false);
  const send = (confirmation: Confirmation) => {
    if (!attempted) frozenAck.current = acknowledged;
    setAttempted(true);
    execute.mutate({ confirmation, acknowledgeDuplicate: frozenAck.current });
  };
  const grant = useMutation({
    mutationFn: (password: string) =>
      api.call('stepUp', { body: { strength: 'password', password }, userActivity: true }),
  });

  const submit = () => {
    setInputError(undefined);
    makePreview.reset();
    const to = address.trim();
    if (!to) return setInputError(tr.t('onchain.addressRequired'));
    const msat = parseSatsInput(amount, tr.locale);
    if (msat === undefined || msat === 0n) return setInputError(tr.t('onchain.invalidAmount'));
    let feeRate: string | undefined;
    if (fee === 'custom') {
      const rate = customRate.trim();
      if (!/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$/.test(rate) || Number(rate) <= 0)
        return setInputError(tr.t('onchain.invalidRate'));
      feeRate = rate;
    } else if (fee !== 'normal') {
      // Normal sends no rate: the server takes the node's own estimate for the next blocks.
      feeRate = presets[fee];
      if (feeRate === undefined) return setInputError(tr.t('onchain.rateUnavailable'));
    }
    makePreview.mutate({ address: to, amount: msat.toString(), ...(feeRate === undefined ? {} : { feeRate }) });
  };

  const failed = execute.error instanceof ApiError && execute.error.code === 'payment_failed';
  const result = execute.data;
  const locked = execute.isPending || grant.isPending;
  const back = `/n/${node.id}/onchain`;
  const coin = COIN[node.chain];
  const chainName = tr.t(`onchain.chainName.${node.chain}`);

  if (!allowed && !preview)
    return (
      <ActionFrame title={tr.t('onchain.sendTitle')} back={back}>
        <ActionUnavailable />
      </ActionFrame>
    );

  if (preview && (result || failed)) {
    const failedIntent =
      execute.error instanceof ApiError &&
      typeof (execute.error.details as { intentId?: unknown } | undefined)?.intentId === 'string'
        ? (execute.error.details as { intentId: string }).intentId
        : undefined;
    const reason = reasonOf(execute.error);
    return (
      <ActionFrame title={tr.t('onchain.sendTitle')} back={back}>
        <div
          role="status"
          data-testid="onchain-outcome"
          data-state={failed ? 'failed' : result?.state}
          className="flex flex-col gap-3"
        >
          <h2
            className={`text-xl font-semibold ${failed ? 'text-danger' : result?.state === 'succeeded' ? 'text-success' : ''}`}
          >
            {tr.t(failed ? 'onchain.failed' : result?.state === 'unknown' ? 'onchain.unknown' : 'onchain.sent')}
          </h2>
          {failed ? (
            <p className="text-sm">
              {tr.t(reason === 'fee_cap_exceeded' ? 'onchain.failedFeeCap' : 'onchain.failedHelp')}
            </p>
          ) : null}
          {result?.state === 'unknown' ? (
            <>
              <p className="text-sm">{tr.t('onchain.unknownHelp')}</p>
              {execute.error ? <SendError error={execute.error} /> : null}
              <Button className="self-start" onClick={() => send(preview)} disabled={locked}>
                {execute.isPending ? tr.t('onchain.checking') : tr.t('onchain.checkAgain')}
              </Button>
            </>
          ) : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {result?.intentId || failedIntent ? (
              <>
                <dt className="text-muted">{tr.t('onchain.intent')}</dt>
                <dd className="min-w-0">
                  <IdValue value={result?.intentId ?? failedIntent ?? ''} />
                </dd>
              </>
            ) : null}
            {result?.txid ? (
              <>
                <dt className="text-muted">{tr.t('onchain.txid')}</dt>
                <dd className="min-w-0">
                  <IdValue value={result.txid} testId="onchain-sent-txid" />
                </dd>
              </>
            ) : null}
          </dl>
          {result?.txid ? (
            <Link
              className="inline-flex min-h-11 items-center text-brand-strong underline"
              to="/n/$node/onchain/tx/$txid"
              params={{ node: node.id, txid: result.txid }}
              data-testid="onchain-tx-link"
            >
              {tr.t('onchain.showTransaction')}
            </Link>
          ) : null}
          <Link
            className="inline-flex min-h-11 items-center text-brand-strong underline"
            to="/n/$node/onchain"
            params={{ node: node.id }}
            search={ONCHAIN_DEFAULTS}
          >
            {tr.t('onchain.back')}
          </Link>
        </div>
      </ActionFrame>
    );
  }

  if (preview) {
    const p = preview.data;
    const total = BigInt(p.cost.total);
    const action = tr.t('onchain.confirm', {
      amount: formatCoins(BigInt(p.amount), tr.locale),
      coin,
      chain: chainName,
    });
    const needsStepUp =
      (p.stepUpRequired && !authorized) ||
      (execute.error instanceof ApiError && execute.error.code === 'step_up_required');
    const mayEdit =
      !locked && (!execute.error || (execute.error instanceof ApiError && EDITABLE.includes(execute.error.code)));
    const act = () => {
      setConfirming(false);
      if (needsStepUp) {
        activeGrant.current = true;
        grant.reset();
        setStepUp(true);
      } else send(preview);
    };
    return (
      <ActionFrame title={tr.t('onchain.sendTitle')} back={back}>
        <PreviewPanel
          title={tr.t('onchain.preview')}
          chain={<ChainBadge identity={p.chainIdentity} />}
          notice={
            fromLink ? (
              <p role="note" className="rounded-card border border-info bg-surface p-3 text-sm" data-testid="from-link">
                {tr.t('onchain.fromLink')}
              </p>
            ) : undefined
          }
          rows={[
            {
              label: tr.t('onchain.address'),
              value: (
                <span className="break-all font-mono" data-testid="preview-address">
                  {p.address}
                </span>
              ),
            },
            { label: tr.t('onchain.addressType'), value: p.addressType },
            { label: tr.t('onchain.amount'), value: <Amount msat={p.amount} cost testId="preview-amount" /> },
            {
              label: tr.t('onchain.feeRate'),
              value: <span data-testid="preview-rate">{tr.t('onchain.rateValue', { rate: p.feeRate })}</span>,
            },
            { label: tr.t('onchain.maxFee'), value: <Amount msat={p.cost.maxFee} cost testId="preview-max-fee" /> },
            { label: tr.t('onchain.total'), value: <Amount msat={p.cost.total} cost />, emphasis: true },
          ]}
          warnings={[
            tr.t('onchain.chainWarning', { coin, chain: chainName }),
            tr.t('onchain.maxFeeHelp'),
            ...(p.feeOverride ? [tr.t('onchain.feeOverride')] : []),
            ...(p.duplicateWarning ? [tr.t('onchain.duplicateWarning')] : []),
          ]}
          confirmLabel={execute.isPending ? tr.t('onchain.sending') : action}
          confirmDisabled={locked || (p.duplicateWarning && !acknowledged)}
          onConfirm={() => setConfirming(true)}
        >
          <p className="text-sm text-muted">{p.scope}</p>
          <p className="text-sm text-muted">
            {tr.t('onchain.previewExpires', { time: formatDateTime(p.expiresAt, tr.locale) })}
          </p>
          {budget.error ? (
            <ErrorNote error={budget.error} onRetry={() => void budget.refetch()} />
          ) : budget.data ? (
            <p className="text-sm" data-testid="preview-remaining">
              {tr.t('onchain.remaining')}:{' '}
              {budget.data.policy === null ? (
                tr.t('onchain.noLimits')
              ) : budget.data.remainingMsat === null ? (
                tr.t('onchain.unlimited')
              ) : (
                <Amount msat={budget.data.remainingMsat} cost />
              )}
            </p>
          ) : null}
          {p.duplicateWarning ? (
            <Field label={tr.t('onchain.acknowledge')} htmlFor="onchain-duplicate">
              <input
                id="onchain-duplicate"
                type="checkbox"
                className="size-[24px]"
                disabled={attempted}
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
            </Field>
          ) : null}
          {execute.error ? <SendError error={execute.error} /> : null}
          {attempted && execute.error && !mayEdit ? <p className="text-sm">{tr.t('onchain.retrySame')}</p> : null}
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
            {tr.t('onchain.edit')}
          </Button>
        </PreviewPanel>
        <Dialog
          open={confirming}
          onOpenChange={setConfirming}
          title={tr.t('onchain.confirmTitle')}
          closeLabel={tr.t('common.close')}
          testId="onchain-confirm"
        >
          <p className="text-sm">
            {tr.t('onchain.confirmText', {
              amount: formatCoins(BigInt(p.amount), tr.locale),
              coin,
              chain: chainName,
              address: p.address,
              total: formatCost(total, tr.locale),
            })}
          </p>
          <p className="break-all font-mono text-sm">{p.address}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>{tr.t('common.cancel')}</Button>
            <Button variant="primary" onClick={act} disabled={locked} data-testid="onchain-confirm-button">
              {action}
            </Button>
          </div>
        </Dialog>
        {stepUp ? (
          <StepUpDialog
            open
            onOpenChange={(open) => {
              activeGrant.current = open;
              setStepUp(open);
            }}
            reason={tr.t(p.feeOverride ? 'onchain.stepUpFee' : 'onchain.stepUpReason')}
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
      </ActionFrame>
    );
  }

  const rateLabel = (choice: Exclude<FeeChoice, 'custom'>) => {
    const rate = presets[choice];
    return rate === undefined
      ? tr.t(`onchain.fee.${choice}`)
      : `${tr.t(`onchain.fee.${choice}`)} · ${tr.t('onchain.rateValue', { rate })}`;
  };
  const parsed = amount.trim() ? parseSatsInput(amount, tr.locale) : undefined;
  return (
    <ActionFrame title={tr.t('onchain.sendTitle')} back={back}>
      {fromLink ? (
        <p role="note" className="rounded-card border border-info bg-surface p-3 text-sm" data-testid="from-link">
          {tr.t('onchain.fromLink')}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <fieldset disabled={makePreview.isPending} className="contents">
          <Field
            label={tr.t('onchain.address')}
            htmlFor="onchain-address"
            hint={tr.t('onchain.addressHint', { chain: chainName })}
          >
            <input
              id="onchain-address"
              className="input font-mono"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={tr.t('onchain.amountSats')} htmlFor="onchain-amount" hint={tr.t('onchain.amountHint')}>
            <input
              id="onchain-amount"
              className="input tabular-nums"
              inputMode="numeric"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          {parsed !== undefined && parsed > 0n ? (
            <p className="text-sm text-muted" data-testid="amount-readback">
              {tr.t('onchain.amountReadback', {
                sats: formatInteger(parsed / 1000n, tr.locale),
                amount: formatCoins(parsed, tr.locale),
                coin,
              })}
            </p>
          ) : null}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{tr.t('onchain.feeLabel')}</legend>
            {(['fast', 'normal', 'slow', 'custom'] as const).map((choice) => (
              <label key={choice} className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="radio"
                  name="onchain-fee"
                  className="size-[24px]"
                  value={choice}
                  checked={fee === choice}
                  onChange={() => setFee(choice)}
                />
                {choice === 'custom' ? tr.t('onchain.fee.custom') : rateLabel(choice)}
              </label>
            ))}
            {fee === 'custom' ? (
              <Field label={tr.t('onchain.customRate')} htmlFor="onchain-rate">
                <input
                  id="onchain-rate"
                  className="input tabular-nums"
                  inputMode="decimal"
                  autoComplete="off"
                  value={customRate}
                  onChange={(e) => setCustomRate(e.target.value)}
                />
              </Field>
            ) : null}
            {fees.error ? <ErrorNote error={fees.error} onRetry={() => void fees.refetch()} /> : null}
            <p className="text-xs text-muted">{tr.t('onchain.feeHelp')}</p>
          </fieldset>
          {inputError ? (
            <p role="alert" className="text-sm text-danger" data-testid="error">
              {inputError}
            </p>
          ) : null}
          {makePreview.error ? <SendError error={makePreview.error} /> : null}
          <Button type="submit" variant="primary" className="self-start">
            {makePreview.isPending ? tr.t('onchain.previewing') : tr.t('onchain.previewAction')}
          </Button>
        </fieldset>
      </form>
    </ActionFrame>
  );
}
