// Settings › Nodes › one node (route map /settings/nodes/:node, Advanced; node-management §1, §2, §5, §6): what the
// credentials allow and when they were last verified, a recheck, a complete replacement of the connection, and
// removal. All three changes need a security step-up. The stored URL and certificate are not readable, so a
// replacement asks for the whole connection again; chain and network stay the node's.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, DestructiveConfirm, StatusPill, SuccessNote, type Tone } from '@lightning-pilot/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodesQuery } from '../../app/queries.ts';
import { settingsNodeRoute } from '../../app/router.tsx';
import { formatDateTime } from '../../i18n/format.ts';
import { ErrorNote } from '../../shell/parts.tsx';
import { NotFound } from '../../shell/pages.tsx';
import { nodeCredentialsQuery } from '../node/queries.ts';
import { EMPTY_NODE_FORM } from './data.ts';
import { NodeConnectionForm, NodeFacts } from './NodesScreen.tsx';
import { SettingsPage } from './parts.tsx';
import { useSecurityGuard } from './step-up.tsx';

const STATE_TONE: Record<string, Tone> = { ok: 'success', revoked: 'danger', missing: 'muted', unknown: 'warning' };

export function NodeSettingsScreen() {
  const api = useApi(),
    tr = useT(),
    queries = useQueryClient(),
    navigate = useNavigate();
  const { node: nodeId } = settingsNodeRoute.useParams();
  const nodes = useQuery(nodesQuery(api));
  const node = nodes.data?.items.find((n) => n.id === nodeId);
  const credentials = useQuery({ ...nodeCredentialsQuery(api, nodeId), enabled: node !== undefined });
  const guard = useSecurityGuard(tr.t('settings.node.reason'));
  const [replacing, setReplacing] = useState(false),
    [removing, setRemoving] = useState(false);
  const [note, setNote] = useState<string>(),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  if (nodes.isSuccess && !node) return <NotFound />;
  if (!node) return null;
  const act = async (fn: () => Promise<void>) => {
    setNote(undefined);
    setError(undefined);
    setPending(true);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  const recheck = () =>
    act(async () => {
      const status = await guard.run(() =>
        api.call('recheckNodeCredentials', { params: { nodeId }, userActivity: true }),
      );
      if (!status) return;
      queries.setQueryData(nodeCredentialsQuery(api, nodeId).queryKey, status);
      setNote(tr.t('settings.node.rechecked'));
    });
  const remove = () =>
    act(async () => {
      setRemoving(false);
      const ok = await guard.run(() =>
        api.call('removeNode', { params: { nodeId }, userActivity: true }).then(() => true),
      );
      if (!ok) return;
      await queries.invalidateQueries({ queryKey: ['nodes'] });
      await navigate({ to: '/settings/nodes', search: {} });
    });
  const status = credentials.data;
  return (
    <SettingsPage title={node.name}>
      <Link to="/settings/nodes" search={{}} className="-mt-2 text-sm text-brand-strong underline">
        {tr.t('settings.nodes.backToNodes')}
      </Link>
      <NodeFacts node={node} />
      {node.adminCredential ? (
        <p className="rounded-control border border-danger p-3 text-sm" data-testid="admin-credential">
          {tr.t('settings.node.adminWarning')}
        </p>
      ) : null}
      <Card
        title={tr.t('settings.node.credentialsTitle')}
        actions={
          <Button onClick={() => void recheck()} disabled={pending}>
            {tr.t('settings.node.recheck')}
          </Button>
        }
      >
        {credentials.isError ? (
          <ErrorNote error={credentials.error} onRetry={() => void credentials.refetch()} />
        ) : null}
        {status ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm" data-testid="credential-status">
            <dt className="text-muted">{tr.t('settings.node.view')}</dt>
            <dd>
              <StatusPill
                tone={STATE_TONE[status.credentials.view] ?? 'muted'}
                label={tr.t(`settings.credential.${status.credentials.view}`)}
              />
            </dd>
            <dt className="text-muted">{tr.t('settings.node.spend')}</dt>
            <dd>
              <StatusPill
                tone={STATE_TONE[status.credentials.spend] ?? 'muted'}
                label={tr.t(`settings.credential.${status.credentials.spend}`)}
              />
            </dd>
            <dt className="text-muted">{tr.t('settings.node.accessLevel')}</dt>
            <dd>{tr.t(`settings.access.${status.accessLevel}`)}</dd>
            <dt className="text-muted">{tr.t('settings.node.checkedAt')}</dt>
            <dd>
              {status.checkedAt === null
                ? tr.t('settings.node.neverChecked')
                : formatDateTime(status.checkedAt, tr.locale)}
            </dd>
            <dt className="text-muted">{tr.t('settings.node.capabilities')}</dt>
            <dd>{tr.plural('settings.node.capabilityCount', status.capabilities.length)}</dd>
          </dl>
        ) : null}
        <p className="mt-3 text-sm text-muted">{tr.t('settings.node.spendStatusNote')}</p>
      </Card>
      <div className="flex flex-wrap gap-4 text-sm">
        <Link to="/settings/nodes/$node/limits" params={{ node: nodeId }} className="underline">
          {tr.t('settings.limits.title')}
        </Link>
        <Link to="/settings/spends" search={{ node: nodeId }} className="underline">
          {tr.t('settings.spends.title')}
        </Link>
      </div>
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {error ? (
        error instanceof ApiError && error.code === 'spend_unknown' ? (
          <p role="alert" className="text-sm text-danger">
            {tr.t('settings.node.removeBlocked')}{' '}
            <Link to="/settings/spends" search={{ node: nodeId }} className="underline">
              {tr.t('settings.spends.title')}
            </Link>
          </p>
        ) : (
          <ErrorNote error={error} />
        )
      ) : null}
      <Card title={tr.t('settings.node.replaceTitle')}>
        {replacing ? (
          <NodeConnectionForm
            initial={{ ...EMPTY_NODE_FORM, name: node.name, chain: node.chain, network: node.network }}
            mode="replace"
            submitLabel={tr.t('settings.node.replaceSubmit')}
            send={(body) => api.call('replaceNode', { params: { nodeId }, body, userActivity: true })}
            onDone={() => {
              setReplacing(false);
              setNote(tr.t('settings.node.replaced'));
              void queries.invalidateQueries({ queryKey: ['nodes'] });
              void queries.invalidateQueries({ queryKey: ['node-credentials', nodeId] });
            }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{tr.t('settings.node.replaceIntro')}</p>
            <Button onClick={() => setReplacing(true)} className="self-start">
              {tr.t('settings.node.replaceTitle')}
            </Button>
          </div>
        )}
      </Card>
      <Card title={tr.t('settings.node.removeTitle')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{tr.t('settings.node.removeIntro')}</p>
          <Button variant="danger" onClick={() => setRemoving(true)} disabled={pending} className="self-start">
            {tr.t('settings.node.remove', { name: node.name })}
          </Button>
        </div>
      </Card>
      <DestructiveConfirm
        open={removing}
        onOpenChange={setRemoving}
        title={tr.t('settings.node.remove', { name: node.name })}
        consequences={tr.t('settings.node.removeConsequences')}
        confirmLabel={tr.t('settings.node.remove', { name: node.name })}
        cancelLabel={tr.t('common.cancel')}
        onConfirm={() => void remove()}
        pending={pending}
      />
      {guard.dialog}
    </SettingsPage>
  );
}
