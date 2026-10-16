import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../api/client.ts';

export const nodeDetailsQuery = (api: ApiClient, nodeId: string) =>
  queryOptions({ queryKey: ['node-details', nodeId], queryFn: () => api.call('nodeDetails', { params: { nodeId } }) });

export const nodeCredentialsQuery = (api: ApiClient, nodeId: string) =>
  queryOptions({
    queryKey: ['node-credentials', nodeId],
    queryFn: () => api.call('nodeCredentials', { params: { nodeId } }),
  });

export const NODE_READ_EVENTS = [
  'block.new',
  'chain_identity.updated',
  'balances.updated',
  'channel.updated',
  'peer.updated',
  'node.reachability',
  'reload',
] as const;

// Events name a node by chain/network/pubkey rather than our UUID. Invalidate these small query families instead
// of copying event payloads into a possibly different node's cache. Only active screens refetch.
export async function refreshNodeReads(client: QueryClient): Promise<void> {
  await Promise.all(
    [
      'node',
      'balances',
      'node-details',
      'node-credentials',
      'channels',
      'closed-channels',
      'channel',
      'peers',
      'spend-policy',
    ].map((key) => client.invalidateQueries({ queryKey: [key] })),
  );
}
