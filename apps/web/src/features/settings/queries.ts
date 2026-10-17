// Query definitions of the settings screens. Reads that need a security grant (known devices, recovery-code count,
// session timeouts) are not queries: they load only after the owner confirms, and stay in the screen's state.
import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '../../api/client.ts';

export const unresolvedQuery = (api: ApiClient, nodeId: string) =>
  queryOptions({
    queryKey: ['unresolved-spends', nodeId],
    queryFn: () => api.call('unresolvedSpends', { params: { nodeId } }),
  });

export const sessionsQuery = (api: ApiClient) =>
  queryOptions({ queryKey: ['sessions'], queryFn: () => api.call('sessions') });

export const spendPolicyQuery = (api: ApiClient, nodeId: string) =>
  queryOptions({ queryKey: ['spend-policy', nodeId], queryFn: () => api.call('spendPolicy', { params: { nodeId } }) });
