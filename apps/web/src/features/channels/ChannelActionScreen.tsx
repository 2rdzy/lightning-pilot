import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelOpenPreviewResponse, ChannelClosePreviewResponse } from '@lightning-pilot/core';
import type { z } from 'zod';
import { Button, DestructiveConfirm, Field, PreviewPanel, StepUpDialog } from '@lightning-pilot/ui';
import { Link } from '@tanstack/react-router';
import { ApiError, newIdempotencyKey } from '../../api/client.ts';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { closeChannelRoute, nodeRoute, openChannelRoute } from '../../app/router.tsx';
import { Amount, ChainBadge, ErrorNote, IdValue } from '../../shell/parts.tsx';
import { formatCost, formatDateTime, parseSatsInput } from '../../i18n/format.ts';
import { refreshNodeReads } from '../node/queries.ts';
import { channelQuery } from './data.ts';
import { ActionFrame, ActionUnavailable, ReplayWarning, inputError, useActionAllowed } from './parts.tsx';

type Preview = z.infer<typeof ChannelOpenPreviewResponse> | z.infer<typeof ChannelClosePreviewResponse>;
interface Confirmation {
  data: Preview;
  key: string;
}

export function OpenChannelScreen() {
  const { node } = nodeRoute.useLoaderData(),
    { peer } = openChannelRoute.useSearch();
  return <ChannelAction key={`${node.id}:${peer ?? ''}`} kind="open" initialPeer={peer ?? ''} />;
}
export function CloseChannelScreen() {
  const { node } = nodeRoute.useLoaderData(),
    { channel } = closeChannelRoute.useParams(),
    { force } = closeChannelRoute.useSearch();
  return (
    <ChannelAction key={`${node.id}:${channel}:${force}`} kind="close" channel={channel} initialForce={force === '1'} />
  );
}

function ChannelAction({
  kind,
  channel,
  initialPeer = '',
  initialForce = false,
}: {
  kind: 'open' | 'close';
  channel?: string;
  initialPeer?: string;
  initialForce?: boolean;
}) {
  const api = useApi(),
    tr = useT(),
    client = useQueryClient();
  const { node } = nodeRoute.useLoaderData();
  const allowed = useActionAllowed(kind === 'open' ? 'channels.open' : 'channels.close');
  const forceAllowed = useActionAllowed('channels.close.force');
  const detail = useQuery({ ...channelQuery(api, node.id, channel ?? ''), enabled: kind === 'close' });
  const budget = useQuery({
    queryKey: ['spend-policy', node.id],
    queryFn: () => api.call('spendPolicy', { params: { nodeId: node.id } }),
  });
  const [peer, setPeer] = useState(initialPeer),
    [amount, setAmount] = useState(''),
    [push, setPush] = useState(''),
    [feeRate, setFeeRate] = useState(''),
    [announce, setAnnounce] = useState(true);
  const [force, setForce] = useState(initialForce),
    [destination, setDestination] = useState('');
  const [preview, setPreview] = useState<Confirmation>(),
    [acknowledged, setAcknowledged] = useState(false),
    [authorized, setAuthorized] = useState(false);
  const [destructive, setDestructive] = useState(false),
    [stepUp, setStepUp] = useState(false);
  const activeGrant = useRef(false);
  useEffect(
    () => () => {
      activeGrant.current = false;
    },
    [],
  );
  const title = tr.t(kind === 'open' ? 'channels.open' : 'channels.close');
  const closeRow =
    detail.data && 'local' in detail.data && !['closing', 'closed'].includes(detail.data.state.group)
      ? detail.data
      : undefined;
  const sats = (text: string): string => {
    const value = parseSatsInput(text, tr.locale);
    if (value === undefined) throw new ApiError('validation_failed', tr.t('channels.invalidAmount'), 400);
    return value.toString();
  };
  const makePreview = useMutation({
    mutationFn: (): Promise<Preview> =>
      kind === 'open'
        ? api.call('previewChannelOpen', {
            params: { nodeId: node.id },
            userActivity: true,
            body: {
              peer: peer.trim(),
              amount: sats(amount),
              ...(push.trim() ? { push: sats(push) } : {}),
              ...(feeRate.trim() ? { feeRate: feeRate.trim() } : {}),
              announce,
            },
          })
        : api.call('previewChannelClose', {
            params: { nodeId: node.id },
            userActivity: true,
            body: {
              channel: closeRow?.id ?? '',
              force,
              ...(!force && destination.trim() ? { destination: destination.trim() } : {}),
            },
          }),
    onSuccess: (data) => {
      setPreview({ data, key: newIdempotencyKey() });
      setAcknowledged(false);
      setAuthorized(false);
    },
  });
  const execute = useMutation({
    mutationFn: (record: Confirmation) =>
      api.call(kind === 'open' ? 'executeChannelOpen' : 'executeChannelClose', {
        params: { nodeId: node.id },
        userActivity: true,
        body: { confirmationToken: record.data.confirmationToken, acknowledgeDuplicate: acknowledged },
        idempotencyKey: record.key,
      }),
    onSettled: () => refreshNodeReads(client),
  });
  const grant = useMutation({
    mutationFn: (password: string) =>
      api.call('stepUp', { body: { strength: 'password', password }, userActivity: true }),
  });
  const act = () => {
    if (!preview) return;
    if (
      (preview.data.stepUpRequired && !authorized) ||
      (execute.error instanceof ApiError && execute.error.code === 'step_up_required')
    ) {
      activeGrant.current = true;
      grant.reset();
      setStepUp(true);
    } else execute.mutate(preview);
  };
  const failed =
    (execute.error instanceof ApiError && execute.error.code === 'payment_failed') || execute.data?.state === 'failed';
  const failureDetails = execute.error instanceof ApiError ? execute.error.details : undefined;
  const failedIntent =
    failureDetails &&
    typeof failureDetails === 'object' &&
    'intentId' in failureDetails &&
    typeof failureDetails.intentId === 'string'
      ? failureDetails.intentId
      : undefined;
  const result = execute.data;
  const locked = execute.isPending || grant.isPending;
  // After an uncertain reply, editing would create a new intent. Keep the original token/key for every retry.
  const mayEdit =
    !locked &&
    (!execute.error ||
      (execute.error instanceof ApiError &&
        [
          'confirmation_invalid',
          'step_up_required',
          'chain_refused',
          'chain_waiting',
          'capability_missing',
          'limit_exceeded',
          'fee_cap_exceeded',
          'validation_failed',
        ].includes(execute.error.code)));
  return (
    <ActionFrame title={title} back={`/n/${node.id}/channels${channel ? `/${encodeURIComponent(channel)}` : ''}`}>
      {initialPeer || initialForce ? <p role="note">{tr.t('channels.fromLink')}</p> : null}
      {detail.error ? <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} /> : null}
      {closeRow?.replayableOnOtherChain ? <ReplayWarning /> : null}
      {!allowed ? (
        <ActionUnavailable />
      ) : kind === 'close' && !closeRow && !preview ? (
        <p>{tr.t(detail.isPending ? 'app.loading' : 'channels.cannotClose')}</p>
      ) : preview ? (
        <>
          {result || failed ? (
            <div role="status" data-testid="channel-outcome" data-state={failed ? 'failed' : result?.state}>
              <h2 className="text-xl font-semibold">
                {tr.t(
                  failed
                    ? 'channels.failed'
                    : result?.state === 'unknown'
                      ? 'channels.unknown'
                      : kind === 'open'
                        ? 'channels.openAccepted'
                        : result?.closeType === 'pending'
                          ? 'channels.closePending'
                          : 'channels.closeAccepted',
                )}
              </h2>
              <p className="mt-2 text-sm">
                {tr.t(result?.state === 'unknown' ? 'channels.unknownHelp' : 'channels.followState')}
              </p>
              {result?.state === 'unknown' ? (
                <Link
                  to="/settings/spends"
                  search={{ node: node.id }}
                  className="text-sm text-brand-strong underline"
                  data-testid="unresolved-link"
                >
                  {tr.t('channels.unresolvedLink')}
                </Link>
              ) : null}
              {result ? (
                <>
                  <p>
                    {tr.t('channels.intent')}: <IdValue value={result.intentId} full />
                  </p>
                  {result.txid ? (
                    <p>
                      <IdValue value={result.txid} full />
                    </p>
                  ) : null}
                </>
              ) : null}
              {!result && failedIntent ? (
                <p>
                  {tr.t('channels.intent')}: <IdValue value={failedIntent} full />
                </p>
              ) : null}
              {execute.error && !failed ? <ErrorNote error={execute.error} /> : null}
              {result?.state === 'unknown' ? (
                <Button onClick={() => execute.mutate(preview)} disabled={locked}>
                  {tr.t('channels.checkResult')}
                </Button>
              ) : null}
              <Link
                className="mt-4 inline-flex min-h-11 items-center text-brand-strong underline"
                to="/n/$node/channels"
                params={{ node: node.id }}
                search={{ state: 'all', q: '', sort: '-capacity', pages: 1 }}
              >
                {tr.t('channels.followChannels')}
              </Link>
            </div>
          ) : (
            <PreviewPanel
              title={tr.t('channels.preview')}
              chain={<ChainBadge identity={preview.data.chainIdentity} />}
              rows={[
                {
                  label: tr.t('channels.peer'),
                  value: <span className="break-all font-mono">{preview.data.peer}</span>,
                },
                {
                  label: tr.t(kind === 'open' ? 'channels.fundingAmount' : 'channels.local'),
                  value: (
                    <Amount msat={'amount' in preview.data ? preview.data.amount : preview.data.localBalance} cost />
                  ),
                },
                ...('push' in preview.data
                  ? [
                      { label: tr.t('channels.push'), value: <Amount msat={preview.data.push} cost /> },
                      { label: tr.t('channels.feeRate'), value: preview.data.feeRate },
                      { label: tr.t('channels.maxFee'), value: <Amount msat={preview.data.cost.maxFee} cost /> },
                    ]
                  : [
                      {
                        label: tr.t('channels.destination'),
                        value: (
                          <span className="break-all">
                            {preview.data.destination ??
                              (preview.data.fundsTo?.ownWallet === false && preview.data.fundsTo.address
                                ? preview.data.fundsTo.address
                                : tr.t('channels.nodeWallet'))}
                          </span>
                        ),
                      },
                    ]),
                {
                  label: tr.t('channels.budgetCost'),
                  value: <Amount msat={preview.data.cost.total} cost />,
                  emphasis: true,
                },
                {
                  label: tr.t('channels.expires'),
                  value: (
                    <time dateTime={preview.data.expiresAt} title={preview.data.expiresAt}>
                      {formatDateTime(preview.data.expiresAt, tr.locale)}
                    </time>
                  ),
                },
              ]}
              warnings={[
                ...(kind === 'close' ? [tr.t('channels.closeFeeUnavailable')] : []),
                ...('fundsTo' in preview.data &&
                preview.data.destination === undefined &&
                preview.data.fundsTo?.ownWallet === false
                  ? [tr.t('channels.externalShutdown')]
                  : []),
                ...(force ? [tr.t('channels.forceWarning')] : []),
                ...(preview.data.duplicateWarning ? [tr.t('channels.duplicateWarning')] : []),
                ...(preview.data.feeOverride ? [tr.t('channels.feeOverride')] : []),
              ]}
              confirmLabel={tr.t(
                kind === 'open' ? 'channels.confirmOpen' : force ? 'channels.confirmForce' : 'channels.confirmClose',
                { amount: formatCost(BigInt(preview.data.cost.total), tr.locale) },
              )}
              confirmDisabled={locked || (preview.data.duplicateWarning && !acknowledged) || (force && !forceAllowed)}
              destructive={kind === 'close'}
              onConfirm={() => {
                if (kind === 'close') setDestructive(true);
                else act();
              }}
            >
              <p className="text-sm text-muted">{preview.data.scope}</p>
              {budget.error ? (
                <ErrorNote error={budget.error} onRetry={() => void budget.refetch()} />
              ) : budget.data ? (
                <p className="text-sm">
                  {tr.t('channels.remaining')}:{' '}
                  {budget.data.policy === null ? (
                    tr.t('channels.noLimits')
                  ) : budget.data.remainingMsat === null ? (
                    tr.t('channels.unlimited')
                  ) : (
                    <Amount msat={budget.data.remainingMsat} cost />
                  )}
                </p>
              ) : null}
              {preview.data.duplicateWarning ? (
                <Field label={tr.t('channels.acknowledge')} htmlFor="channel-duplicate">
                  <input
                    id="channel-duplicate"
                    disabled={execute.isPending || !!execute.error}
                    type="checkbox"
                    className="size-[24px]"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                </Field>
              ) : null}
              {execute.error ? <ErrorNote error={execute.error} /> : null}
              <Button
                disabled={!mayEdit}
                onClick={() => {
                  setPreview(undefined);
                  execute.reset();
                  makePreview.reset();
                  setAuthorized(false);
                }}
              >
                {tr.t('channels.edit')}
              </Button>
            </PreviewPanel>
          )}
          <DestructiveConfirm
            open={destructive}
            onOpenChange={setDestructive}
            title={tr.t(force ? 'channels.forceClose' : 'channels.close')}
            consequences={tr.t(force ? 'channels.forceWarning' : 'channels.closeWarning')}
            confirmLabel={tr.t(force ? 'channels.forceClose' : 'channels.close')}
            cancelLabel={tr.t('common.cancel')}
            pending={locked}
            onConfirm={() => {
              setDestructive(false);
              act();
            }}
          />
          {stepUp ? (
            <StepUpDialog
              open
              onOpenChange={(open) => {
                activeGrant.current = open;
                setStepUp(open);
              }}
              reason={tr.t(force ? 'channels.forceStepUp' : 'channels.stepUpReason')}
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
                    execute.mutate(preview);
                  },
                })
              }
            />
          ) : null}
        </>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            makePreview.mutate();
          }}
        >
          <fieldset disabled={makePreview.isPending} className="contents">
            {kind === 'open' ? (
              <>
                <Field label={tr.t('channels.peer')} htmlFor="open-peer">
                  <input
                    id="open-peer"
                    className="input font-mono"
                    value={peer}
                    onChange={(e) => setPeer(e.target.value)}
                    maxLength={66}
                    required
                    autoComplete="off"
                  />
                </Field>
                <Field label={tr.t('channels.fundingAmount')} htmlFor="open-amount">
                  <input
                    id="open-amount"
                    className="input"
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                </Field>
                <Field label={tr.t('channels.push')} htmlFor="open-push" hint={tr.t('channels.pushHelp')}>
                  <input
                    id="open-push"
                    className="input"
                    inputMode="numeric"
                    value={push}
                    onChange={(e) => setPush(e.target.value)}
                  />
                </Field>
                <Field label={tr.t('channels.feeRate')} htmlFor="open-fee" hint={tr.t('channels.feeHelp')}>
                  <input
                    id="open-fee"
                    className="input"
                    inputMode="decimal"
                    value={feeRate}
                    onChange={(e) => setFeeRate(e.target.value)}
                  />
                </Field>
                <Field label={tr.t('channels.public')} htmlFor="open-public">
                  <input
                    id="open-public"
                    type="checkbox"
                    className="size-[24px]"
                    checked={announce}
                    onChange={(e) => setAnnounce(e.target.checked)}
                  />
                </Field>
              </>
            ) : (
              <>
                <p className="break-all font-mono">{closeRow?.shortChannelId ?? closeRow?.id}</p>
                <Field label={tr.t('channels.forceClose')} htmlFor="close-force" hint={tr.t('channels.forceWarning')}>
                  <input
                    id="close-force"
                    type="checkbox"
                    className="size-[24px]"
                    checked={force}
                    disabled={!forceAllowed}
                    onChange={(e) => {
                      setForce(e.target.checked);
                      if (e.target.checked) setDestination('');
                    }}
                  />
                </Field>
                {!force ? (
                  <Field
                    label={tr.t('channels.destination')}
                    htmlFor="close-destination"
                    hint={tr.t('channels.destinationHelp')}
                  >
                    <input
                      id="close-destination"
                      className="input font-mono"
                      value={destination}
                      onChange={(e) => setDestination(e.target.value)}
                      maxLength={200}
                    />
                  </Field>
                ) : null}
                <p className="text-sm">{tr.t('channels.closeFeeUnavailable')}</p>
              </>
            )}
            {makePreview.error ? <ErrorNote error={inputError(makePreview.error)} /> : null}
            <Button type="submit" variant="primary" disabled={makePreview.isPending || (force && !forceAllowed)}>
              {tr.t('channels.preview')}
            </Button>
          </fieldset>
        </form>
      )}
    </ActionFrame>
  );
}
