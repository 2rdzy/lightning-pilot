// Settings › Nodes (route map /settings/nodes, Advanced; node-management §1–§3): the nodes with their access level and
// what they still need, and adding a node: the setup command for the node host, the connection, the credentials,
// the admin acknowledgement and, for a spending node without limits yet, the limits step. Adding needs a security
// step-up; the server connects to the node and checks the credentials and the chain before it stores anything.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, EmptyState, Field, StatusPill, SuccessNote } from '@lightning-pilot/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodesQuery } from '../../app/queries.ts';
import { settingsNodesRoute } from '../../app/router.tsx';
import { ChainBadge, CopyButton, ErrorNote } from '../../shell/parts.tsx';
import {
  DEFAULT_POLICY_FORM,
  EMPTY_NODE_FORM,
  formToPolicy,
  needsAdminAcknowledgement,
  needsLimits,
  nodeRequest,
  type NodeForm,
  type NodeRow,
  type PolicyForm,
} from './data.ts';
import { FormError, LimitsFields, NodeFields, SettingsPage } from './parts.tsx';
import { useSecurityGuard } from './step-up.tsx';

export function NodeFacts({ node }: { node: NodeRow }) {
  const tr = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <ChainBadge identity={node.chainIdentity} />
      <span className="text-muted">{node.network}</span>
      <StatusPill
        tone={node.accessLevel === 'admin' ? 'danger' : 'muted'}
        label={tr.t(`settings.access.${node.accessLevel ?? (node.canSpend ? 'standard' : 'read-only')}`)}
      />
      {node.canSpend ? null : <StatusPill tone="muted" label={tr.t('settings.nodes.cannotSpend')} />}
      {node.limitsRequired && node.canSpend ? (
        <StatusPill tone="warning" label={tr.t('settings.nodes.limitsMissing')} />
      ) : null}
    </div>
  );
}

function SetupCommand() {
  const api = useApi(),
    tr = useT(),
    id = useId();
  const [level, setLevel] = useState<'read-only' | 'standard' | 'full'>('standard');
  const [result, setResult] = useState<{ command: string; instructions: string }>();
  const [error, setError] = useState<unknown>();
  const show = async () => {
    setError(undefined);
    try {
      setResult(await api.call('nodeSetupCommand', { body: { accessLevel: level }, userActivity: true }));
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-control border border-border p-3">
      <p className="text-sm">{tr.t('settings.node.commandIntro')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={tr.t('settings.node.accessLevel')} htmlFor={`${id}-level`}>
          <select
            id={`${id}-level`}
            className="input"
            value={level}
            onChange={(e) => {
              setLevel(e.target.value as typeof level);
              setResult(undefined);
            }}
          >
            {(['read-only', 'standard', 'full'] as const).map((l) => (
              <option key={l} value={l}>
                {tr.t(`settings.access.${l}`)}
              </option>
            ))}
          </select>
        </Field>
        <Button onClick={() => void show()}>{tr.t('settings.node.commandShow')}</Button>
      </div>
      <p className="text-sm text-muted">{tr.t(`settings.access.${level}.help`)}</p>
      {result ? (
        <>
          <pre
            className="max-h-64 overflow-auto rounded-control bg-bg p-3 font-mono text-xs whitespace-pre-wrap"
            // Scrollable, so it must be reachable by keyboard (axe scrollable-region-focusable).
            tabIndex={0}
            aria-label={tr.t('settings.node.commandLabel')}
            data-testid="setup-command"
          >
            {result.command}
          </pre>
          <CopyButton value={result.command} />
          <p className="text-sm text-muted">{result.instructions}</p>
        </>
      ) : null}
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}

// Add or replace: the same form, the same limits step. `send` performs the request with or without limits.
export function NodeConnectionForm({
  initial,
  mode,
  submitLabel,
  send,
  onDone,
}: {
  initial: NodeForm;
  mode: 'add' | 'replace';
  submitLabel: string;
  send: (body: NonNullable<ReturnType<typeof nodeRequest>>) => Promise<NodeRow>;
  onDone: (node: NodeRow) => void;
}) {
  const tr = useT();
  const guard = useSecurityGuard(tr.t('settings.node.reason'));
  const [form, setForm] = useState<NodeForm>(initial);
  const [limits, setLimits] = useState<PolicyForm>();
  const [note, setNote] = useState<string>(),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  const submit = async () => {
    setNote(undefined);
    setError(undefined);
    if (needsAdminAcknowledgement(form) && !form.adminAcknowledged) return setNote(tr.t('settings.node.adminRequired'));
    let policy;
    if (limits) {
      const checked = formToPolicy(limits);
      if (!checked.ok)
        return setNote(tr.t(checked.reason === 'order' ? 'settings.limits.order' : 'settings.limits.invalid'));
      policy = checked.policy;
    }
    const body = nodeRequest(form, policy);
    if (!body) return setNote(tr.t('settings.node.invalid'));
    setPending(true);
    try {
      const node = await guard.run(() => send(body));
      if (node) onDone(node);
    } catch (err) {
      // A spending node whose identity has no limits yet: ask for them and send again (node-management §2).
      if (needsLimits(err) && !limits) {
        setLimits({ ...DEFAULT_POLICY_FORM });
        setNote(tr.t('settings.node.limitsNeeded'));
      } else setError(err);
    } finally {
      setPending(false);
    }
  };
  // The step-up dialog stays outside the form: React carries its submit event through the portal to every ancestor,
  // so inside this form it would send the node request a second time.
  return (
    <>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        data-testid={`node-form-${mode}`}
      >
        <NodeFields form={form} onChange={setForm} mode={mode} />
        {limits ? (
          <Card title={tr.t('settings.limits.title')}>
            <LimitsFields form={limits} onChange={setLimits} />
          </Card>
        ) : null}
        {note ? (
          <p role="alert" className="text-sm text-danger">
            {note}
          </p>
        ) : null}
        {error ? <FormError error={error} /> : null}
        {pending ? (
          <p role="status" className="text-sm text-muted">
            {tr.t('settings.node.checking')}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={pending} className="self-start">
          {limits ? tr.t('settings.node.submitWithLimits') : submitLabel}
        </Button>
      </form>
      {guard.dialog}
    </>
  );
}

export function NodesScreen() {
  const api = useApi(),
    tr = useT(),
    queries = useQueryClient();
  const navigate = useNavigate();
  const { add } = settingsNodesRoute.useSearch();
  const nodes = useQuery(nodesQuery(api));
  const [added, setAdded] = useState<string>();
  const items = nodes.data?.items ?? [];
  return (
    <SettingsPage
      title={tr.t('settings.nodes.title')}
      intro={tr.t('settings.nodes.intro')}
      actions={
        add ? null : (
          <Button variant="primary" onClick={() => void navigate({ to: '/settings/nodes', search: { add: true } })}>
            {tr.t('settings.nodes.add')}
          </Button>
        )
      }
    >
      {added ? <SuccessNote>{tr.t('settings.nodes.added', { name: added })}</SuccessNote> : null}
      {add ? (
        <Card title={tr.t('settings.nodes.add')}>
          <div className="flex flex-col gap-4">
            <SetupCommand />
            <NodeConnectionForm
              initial={EMPTY_NODE_FORM}
              mode="add"
              submitLabel={tr.t('settings.nodes.addSubmit')}
              send={(body) => api.call('addNode', { body, userActivity: true })}
              onDone={(node) => {
                setAdded(node.name);
                void queries.invalidateQueries({ queryKey: ['nodes'] });
                void navigate({ to: '/settings/nodes', search: {} });
              }}
            />
            <Link to="/settings/nodes" search={{}} className="text-sm text-brand-strong underline">
              {tr.t('common.cancel')}
            </Link>
          </div>
        </Card>
      ) : null}
      {nodes.isError ? <ErrorNote error={nodes.error} onRetry={() => void nodes.refetch()} /> : null}
      {nodes.isSuccess && items.length === 0 && !add ? (
        <EmptyState title={tr.t('settings.nodes.emptyTitle')} body={tr.t('settings.nodes.emptyBody')} />
      ) : null}
      <ul className="flex flex-col gap-3" data-testid="settings-nodes">
        {items.map((n) => (
          <li key={n.id}>
            <Card>
              <div className="flex flex-col gap-2">
                <Link
                  to="/settings/nodes/$node"
                  params={{ node: n.id }}
                  className="text-lg font-semibold text-brand-strong underline"
                >
                  {n.name}
                </Link>
                <NodeFacts node={n} />
                <div className="flex flex-wrap gap-4 text-sm">
                  <Link to="/settings/nodes/$node" params={{ node: n.id }} className="underline">
                    {tr.t('settings.nodes.connection')}
                  </Link>
                  <Link to="/settings/nodes/$node/limits" params={{ node: n.id }} className="underline">
                    {tr.t('settings.limits.title')}
                  </Link>
                  <Link to="/settings/spends" search={{ node: n.id }} className="underline">
                    {tr.t('settings.spends.title')}
                  </Link>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </SettingsPage>
  );
}
