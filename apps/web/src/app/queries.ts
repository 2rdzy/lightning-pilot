// Query definitions shared by the routes and screens, so each piece of server data has one key.
import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '../api/client.ts';

export const nodesQuery = (api: ApiClient) => queryOptions({ queryKey: ['nodes'], queryFn: () => api.call('nodes') });

export const nodeInfoQuery = (api: ApiClient, nodeId: string) =>
  queryOptions({ queryKey: ['node', nodeId], queryFn: () => api.call('node', { params: { nodeId } }) });

export const balancesQuery = (api: ApiClient, nodeId: string) =>
  queryOptions({ queryKey: ['balances', nodeId], queryFn: () => api.call('balances', { params: { nodeId } }) });
