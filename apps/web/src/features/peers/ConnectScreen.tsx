import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Button, Field } from '@lightning-pilot/ui';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { connectPeerRoute, nodeRoute } from '../../app/router.tsx';
import { ErrorNote } from '../../shell/parts.tsx';
import { refreshNodeReads } from '../node/queries.ts';
import { ActionFrame, ActionUnavailable, inputError, useActionAllowed } from '../channels/parts.tsx';

export function ConnectScreen() {
  const { node } = nodeRoute.useLoaderData();
  return <ConnectForm key={`${node.id}:${connectPeerRoute.useSearch().peer ?? ''}`} />;
}
function ConnectForm() {
  const api = useApi(),
    tr = useT(),
    navigate = useNavigate(),
    client = useQueryClient();
  const { node } = nodeRoute.useLoaderData();
  const { peer } = connectPeerRoute.useSearch();
  const [uri, setUri] = useState(peer ?? '');
  const allowed = useActionAllowed('peers.manage');
  const mutation = useMutation({
    mutationFn: () =>
      api.call('connectPeer', { params: { nodeId: node.id }, body: { uri: uri.trim() }, userActivity: true }),
    onSuccess: () => refreshNodeReads(client),
  });
  return (
    <ActionFrame title={tr.t('peers.connect')} back={`/n/${node.id}/peers`}>
      {peer ? <p role="note">{tr.t('channels.fromLink')}</p> : null}
      {!allowed ? (
        <ActionUnavailable />
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(undefined, {
              onSuccess: (result) =>
                void navigate({
                  to: '/n/$node/peers/$pubkey',
                  params: { node: node.id, pubkey: result.pubkey },
                  search: { state: 'all', q: '', sort: 'peer', pages: 1 },
                }),
            });
          }}
        >
          <Field label={tr.t('peers.uri')} htmlFor="connect-uri" hint={tr.t('peers.uriHelp')}>
            <input
              disabled={mutation.isPending}
              id="connect-uri"
              className="input font-mono"
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              maxLength={300}
              required
              autoComplete="off"
            />
          </Field>
          {mutation.error ? <ErrorNote error={inputError(mutation.error)} /> : null}
          <Button type="submit" variant="primary" disabled={mutation.isPending || uri.trim().length < 66}>
            {tr.t('peers.connect')}
          </Button>
        </form>
      )}
    </ActionFrame>
  );
}
