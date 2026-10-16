import { useQuery } from '@tanstack/react-query';
import {
  Card,
  EmptyState,
  NodeAlias,
  PageHeader,
  QrBlock,
  QrCode,
  SkeletonRows,
  StatusPill,
} from '@lightning-pilot/ui';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodeRoute } from '../../app/router.tsx';
import { formatDateTime, formatInteger } from '../../i18n/format.ts';
import { ErrorNote, IdValue, useCopyLabels } from '../../shell/parts.tsx';
import { IdentityPanel } from './IdentityPanel.tsx';
import { nodeCredentialsQuery, nodeDetailsQuery } from './queries.ts';

export function NodeScreen() {
  const api = useApi();
  const tr = useT();
  const labels = useCopyLabels();
  const { node } = nodeRoute.useLoaderData();
  const info = useQuery(nodeDetailsQuery(api, node.id));
  const credentials = useQuery(nodeCredentialsQuery(api, node.id));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={tr.t('node.title')} />
      {info.error ? <ErrorNote error={info.error} onRetry={() => void info.refetch()} /> : null}
      {info.error && info.data ? (
        <p role="status" className="text-sm text-warning">
          {tr.t('node.stale')}
        </p>
      ) : null}
      {info.isPending ? <SkeletonRows label={tr.t('app.loading')} /> : null}
      <Card title={tr.t('node.identity')}>
        <IdentityPanel identity={info.data?.chainIdentity ?? node.chainIdentity} />
      </Card>
      {info.data ? (
        <>
          <Card title={tr.t('node.overview')}>
            <NodeAlias alias={info.data.alias} pubkey={info.data.pubkey} labels={labels} />
            <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted">{tr.t('node.pubkey')}</dt>
              <dd>
                <IdValue value={info.data.pubkey} full testId="node-pubkey" />
                <QrCode value={info.data.pubkey} label={tr.t('node.pubkey')} preserveCase testId="node-pubkey-qr" />
              </dd>
              <dt className="text-muted">{tr.t('node.network')}</dt>
              <dd>{info.data.network}</dd>
              <dt className="text-muted">{tr.t('node.implementation')}</dt>
              <dd>{tr.t(`node.implementation.${info.data.implementation}`)}</dd>
              <dt className="text-muted">{tr.t('node.version')}</dt>
              <dd className="break-all font-mono">{info.data.version}</dd>
              <dt className="text-muted">{tr.t('node.height')}</dt>
              <dd>{formatInteger(info.data.blockHeight, tr.locale)}</dd>
              <dt className="text-muted">{tr.t('node.sync')}</dt>
              <dd>
                <StatusPill
                  tone={info.data.synced ? 'success' : 'warning'}
                  label={tr.t(info.data.synced ? 'node.synced' : 'node.syncing')}
                />
              </dd>
              <dt className="text-muted">{tr.t('node.features')}</dt>
              <dd className="break-all font-mono">{info.data.features || tr.t('node.none')}</dd>
            </dl>
          </Card>
          <Card title={tr.t('node.connections')}>
            <p className="mb-4 text-sm text-muted">{tr.t('node.connectionsHelp')}</p>
            {info.data.addresses.length ? (
              <div className="grid gap-6 md:grid-cols-2">
                {info.data.addresses.map((address) => {
                  const uri = `${info.data.pubkey}@${address}`;
                  return (
                    <QrBlock
                      key={address}
                      value={uri}
                      label={tr.t('node.uriQr')}
                      copyLabels={labels}
                      preserveCase
                      textTestId="node-uri"
                    />
                  );
                })}
              </div>
            ) : (
              <EmptyState title={tr.t('node.noAddresses')} body={tr.t('node.noAddressesHelp')} />
            )}
          </Card>
          <Card title={tr.t('node.capabilities')}>
            <p className="mb-3 text-sm text-muted">{tr.t('node.capabilitiesHelp')}</p>
            {info.data.capabilities.length ? (
              <ul className="flex flex-wrap gap-2">
                {info.data.capabilities.map((capability) => (
                  <li key={capability}>
                    <StatusPill tone="info" label={capability} />
                  </li>
                ))}
              </ul>
            ) : (
              <p>{tr.t('node.noCapabilities')}</p>
            )}
          </Card>
        </>
      ) : null}
      <Card title={tr.t('node.credentials')}>
        {credentials.error ? <ErrorNote error={credentials.error} onRetry={() => void credentials.refetch()} /> : null}
        {credentials.error && credentials.data ? (
          <p role="status" className="text-sm text-warning">
            {tr.t('node.stale')}
          </p>
        ) : null}
        {credentials.isPending ? <SkeletonRows label={tr.t('app.loading')} rows={2} /> : null}
        {credentials.data ? (
          <>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted">{tr.t('node.access')}</dt>
              <dd>{tr.t(`node.access.${credentials.data.accessLevel}`)}</dd>
              {(['view', 'spend'] as const).map((kind) => {
                const state = credentials.data.credentials[kind];
                return (
                  <div key={kind} className="contents">
                    <dt className="text-muted">{tr.t(`node.credential.${kind}`)}</dt>
                    <dd>
                      <StatusPill
                        tone={state === 'ok' ? 'success' : state === 'revoked' ? 'danger' : 'warning'}
                        label={tr.t(`node.credential.${state}`)}
                      />
                    </dd>
                  </div>
                );
              })}
              <dt className="text-muted">{tr.t('node.verifiedAt')}</dt>
              <dd>
                {credentials.data.checkedAt ? (
                  <time dateTime={credentials.data.checkedAt} title={credentials.data.checkedAt}>
                    {formatDateTime(credentials.data.checkedAt, tr.locale)}
                  </time>
                ) : (
                  tr.t('node.neverVerified')
                )}
              </dd>
            </dl>
            <p className="mt-3 text-sm text-muted">{tr.t('node.credentialFreshness')}</p>
          </>
        ) : null}
      </Card>
    </div>
  );
}
