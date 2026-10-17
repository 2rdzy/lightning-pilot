// Settings › Nodes › limits (route map /settings/nodes/:node/limits, Advanced; story U9; spend policy §2): the
// spending limits and the step-up threshold of one node, with what the last 24 hours used. They apply only to
// spends made through Lightning Pilot, to every node with the same chain and public key. Saving needs a security
// step-up.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, SuccessNote } from '@lightning-pilot/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodesQuery } from '../../app/queries.ts';
import { settingsLimitsRoute } from '../../app/router.tsx';
import { Amount, ErrorNote } from '../../shell/parts.tsx';
import { NotFound } from '../../shell/pages.tsx';
import { formToPolicy, policyToForm, type PolicyForm } from './data.ts';
import { NodeFacts } from './NodesScreen.tsx';
import { LimitsFields, SettingsPage } from './parts.tsx';
import { spendPolicyQuery } from './queries.ts';
import { useSecurityGuard } from './step-up.tsx';

export function LimitsScreen() {
  const api = useApi(),
    tr = useT(),
    queries = useQueryClient();
  const { node: nodeId } = settingsLimitsRoute.useParams();
  const nodes = useQuery(nodesQuery(api));
  const node = nodes.data?.items.find((n) => n.id === nodeId);
  const policy = useQuery({ ...spendPolicyQuery(api, nodeId), enabled: node !== undefined });
  const guard = useSecurityGuard(tr.t('settings.limits.reason'));
  const [form, setForm] = useState<PolicyForm>();
  const [note, setNote] = useState<string>(),
    [error, setError] = useState<unknown>(),
    [saved, setSaved] = useState(false),
    [pending, setPending] = useState(false);
  // The form starts from the stored policy once, and is not overwritten by a later refresh while it is edited.
  useEffect(() => {
    if (policy.data && form === undefined) setForm(policyToForm(policy.data.policy));
  }, [policy.data, form]);
  if (nodes.isSuccess && !node) return <NotFound />;
  if (!node) return null;
  const save = async () => {
    if (!form) return;
    setNote(undefined);
    setError(undefined);
    setSaved(false);
    const checked = formToPolicy(form);
    if (!checked.ok)
      return setNote(tr.t(checked.reason === 'order' ? 'settings.limits.order' : 'settings.limits.invalid'));
    setPending(true);
    try {
      const ok = await guard.run(() =>
        api
          .call('updateSpendPolicy', { params: { nodeId }, body: checked.policy, userActivity: true })
          .then(() => true),
      );
      if (ok) {
        setSaved(true);
        await queries.invalidateQueries({ queryKey: ['spend-policy', nodeId] });
        await queries.invalidateQueries({ queryKey: ['nodes'] });
      }
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsPage title={tr.t('settings.limits.titleFor', { name: node.name })} intro={tr.t('settings.limits.intro')}>
      <Link to="/settings/nodes/$node" params={{ node: nodeId }} className="-mt-2 text-sm text-brand-strong underline">
        {tr.t('settings.limits.backToNode', { name: node.name })}
      </Link>
      <NodeFacts node={node} />
      {policy.isError ? <ErrorNote error={policy.error} onRetry={() => void policy.refetch()} /> : null}
      {policy.data ? (
        <Card title={tr.t('settings.limits.usageTitle')}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm" data-testid="limits-usage">
            <dt className="text-muted">{tr.t('settings.limits.used')}</dt>
            <dd>
              <Amount msat={policy.data.usedMsat} testId="limits-used" />
            </dd>
            <dt className="text-muted">{tr.t('settings.limits.remaining')}</dt>
            <dd>
              {policy.data.remainingMsat === null ? (
                tr.t('settings.limits.noDailyLimit')
              ) : (
                <Amount msat={policy.data.remainingMsat} testId="limits-remaining" />
              )}
            </dd>
          </dl>
          {policy.data.policy === null ? (
            <p className="mt-3 text-sm text-warning" data-testid="limits-none">
              {tr.t('settings.limits.none')}
            </p>
          ) : null}
        </Card>
      ) : null}
      {form ? (
        <Card title={tr.t('settings.limits.title')}>
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <LimitsFields form={form} onChange={setForm} />
            <p className="text-sm text-muted">{tr.t('settings.limits.feeShareNote')}</p>
            {note ? (
              <p role="alert" className="text-sm text-danger">
                {note}
              </p>
            ) : null}
            {error ? <ErrorNote error={error} /> : null}
            {saved ? <SuccessNote>{tr.t('settings.limits.saved')}</SuccessNote> : null}
            <Button type="submit" variant="primary" disabled={pending} className="self-start">
              {tr.t('settings.limits.save')}
            </Button>
          </form>
        </Card>
      ) : null}
      {guard.dialog}
    </SettingsPage>
  );
}
