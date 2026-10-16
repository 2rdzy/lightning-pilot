import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '../../api/client.ts';

export const peersQuery = (api: ApiClient, nodeId: string) =>
  queryOptions({ queryKey: ['peers', nodeId], queryFn: () => api.call('peers', { params: { nodeId } }) });

// Init feature hex is big-endian. Index bytes from the right; JS bit shifts alone cannot address bits 512+.
export function peerFeatures(hex: string | undefined): string[] {
  if (!hex || !/^(?:[0-9a-f]{2})+$/.test(hex)) return [];
  return ([512, 513, 514, 515] as const)
    .filter((bit) => {
      const start = hex.length - 2 * (Math.floor(bit / 8) + 1);
      return start >= 0 && (Number.parseInt(hex.slice(start, start + 2), 16) & (1 << (bit % 8))) !== 0;
    })
    .map((bit) => `peers.feature.${bit}`);
}
