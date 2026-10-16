import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button, Card, DestructiveConfirm, Field, PageHeader, SkeletonRows, StatusPill } from '@lightning-pilot/ui';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodeRoute, peerRoute } from '../../app/router.tsx';
import { ErrorNote, IdValue } from '../../shell/parts.tsx';
import { refreshNodeReads } from '../node/queries.ts';
import { channelsQuery } from '../channels/data.ts';
import { ChannelTable, useActionAllowed } from '../channels/parts.tsx';
import { peerFeatures, peersQuery } from './data.ts';

export function PeerScreen() {
  const { node } = nodeRoute.useLoaderData();
  const { pubkey } = peerRoute.useParams();
  return <PeerDetails key={`${node.id}:${pubkey}`} />;
}
function PeerDetails() {
  const api = useApi(),
    tr = useT(),
    client = useQueryClient(),
    navigate = useNavigate();
  const { node } = nodeRoute.useLoaderData();
  const { pubkey } = peerRoute.useParams();
  const search = peerRoute.useSearch();
  const peers = useQuery(peersQuery(api, node.id));
  const channels = useQuery(channelsQuery(api, node.id, search.pages, false));
  const peer = peers.data?.items.find((p) => p.pubkey === pubkey);
  const allowed = useActionAllowed('peers.manage');
  const [confirm, setConfirm] = useState(false),
    [force, setForce] = useState(false);
  const disconnect = useMutation({
    mutationFn: () =>
      api.call('disconnectPeer', { params: { nodeId: node.id, pubkey }, body: { force }, userActivity: true }),
    onSuccess: async () => {
      setConfirm(false);
      await refreshNodeReads(client);
    },
  });
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title={tr.t('peers.detail')} />
      {peers.error ? <ErrorNote error={peers.error} onRetry={() => void peers.refetch()} /> : null}
      {peers.isPending ? <SkeletonRows label={tr.t('app.loading')} /> : null}
      {peers.data && !peer ? <p role="alert">{tr.t('peers.notFound')}</p> : null}
      {peer ? (
        <>
          <Card title={tr.t('peers.detail')}>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 text-sm">
              <dt>{tr.t('channels.peer')}</dt>
              <dd>
                <IdValue value={peer.pubkey} full />
              </dd>
              <dt>{tr.t('dashboard.alias')}</dt>
              <dd className="break-words">{peer.alias?.slice(0, 32) ?? tr.t('peers.unknownAlias')}</dd>
              <dt>{tr.t('channels.state')}</dt>
              <dd>
                <StatusPill
                  tone={peer.connected ? 'success' : 'muted'}
                  label={tr.t(peer.connected ? 'peers.connected' : 'peers.disconnected')}
                />
              </dd>
              <dt>{tr.t('peers.addresses')}</dt>
              <dd className="break-all">{peer.addresses.join(', ') || tr.t('channels.unavailable')}</dd>
              <dt>{tr.t('peers.features')}</dt>
              <dd className="break-all font-mono">{peer.features || tr.t('channels.unavailable')}</dd>
            </dl>
            <ul className="mt-3 flex flex-wrap gap-2">
              {peerFeatures(peer.features).map((key) => (
                <li key={key}>
                  <StatusPill tone="info" label={tr.t(key)} />
                </li>
              ))}
            </ul>
          </Card>
          {allowed ? (
            <Card title={tr.t('peers.actions')}>
              {peer.connected ? (
                <>
                  <Field label={tr.t('peers.forceDisconnect')} htmlFor="force-disconnect">
                    <input
                      id="force-disconnect"
                      type="checkbox"
                      className="size-[24px]"
                      checked={force}
                      onChange={(e) => setForce(e.target.checked)}
                    />
                  </Field>
                  <Button variant="danger" onClick={() => setConfirm(true)}>
                    {tr.t('peers.disconnect')}
                  </Button>
                </>
              ) : (
                <Link
                  className="btn-secondary"
                  to="/n/$node/peers/connect"
                  params={{ node: node.id }}
                  search={{ peer: pubkey }}
                >
                  {tr.t('peers.connect')}
                </Link>
              )}
              <Link
                className="btn-primary ml-3"
                to="/n/$node/channels/open"
                params={{ node: node.id }}
                search={{ peer: pubkey }}
              >
                {tr.t('channels.open')}
              </Link>
              {disconnect.error ? <ErrorNote error={disconnect.error} onRetry={() => setConfirm(true)} /> : null}
            </Card>
          ) : null}
          <DestructiveConfirm
            open={confirm}
            onOpenChange={setConfirm}
            title={tr.t('peers.disconnect')}
            consequences={tr.t('peers.disconnectWarning')}
            confirmLabel={tr.t('peers.disconnect')}
            cancelLabel={tr.t('common.cancel')}
            pending={disconnect.isPending}
            onConfirm={() => disconnect.mutate()}
          />
        </>
      ) : null}
      <h2 className="text-xl font-semibold">{tr.t('peers.channels')}</h2>
      {channels.error ? <ErrorNote error={channels.error} onRetry={() => void channels.refetch()} /> : null}
      {channels.data?.nextCursor ? <p role="note">{tr.t('channels.partial')}</p> : null}
      <ChannelTable
        rows={
          channels.data
            ? channels.data.items.filter((c) => c.peer?.pubkey === pubkey)
            : channels.isPending
              ? undefined
              : []
        }
      />
      {channels.data?.nextCursor && search.pages < 50 ? (
        <Button
          onClick={() =>
            void navigate({
              to: '/n/$node/peers/$pubkey',
              params: { node: node.id, pubkey },
              search: { ...search, pages: search.pages + 1 },
            })
          }
        >
          {tr.t('channels.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
