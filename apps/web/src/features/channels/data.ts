import { ChannelRef, PubkeySchema, CHANNEL_STATE_GROUPS } from '@lightning-pilot/core';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, type ApiClient } from '../../api/client.ts';

export const ListSearch = z.object({
  state: z.enum(['all', ...CHANNEL_STATE_GROUPS]).catch('all'),
  q: z.string().max(200).catch(''),
  sort: z.enum(['capacity', '-capacity', 'local', '-local', 'remote', '-remote', 'peer', '-peer']).catch('-capacity'),
  pages: z.coerce.number().int().min(1).max(50).catch(1),
});
export const DetailSearch = z.object({ tab: z.enum(['overview', 'policy']).catch('overview') });
export const OpenSearch = z.object({ peer: PubkeySchema.optional().catch(undefined) });
export const CloseSearch = z.object({
  force: z.coerce
    .string()
    .pipe(z.enum(['0', '1']))
    .catch('0'),
});
export { ChannelRef, PubkeySchema };

// Only the requested pages are loaded. The UI labels partial results and preserves this bound in the URL.
export async function channelPages(api: ApiClient, nodeId: string, pages: number, closed = false) {
  const read = (cursor?: string) =>
    closed
      ? api.call('closedChannels', { params: { nodeId }, query: { limit: 50, cursor } })
      : api.call('channels', { params: { nodeId }, query: { limit: 50, cursor } });
  const first = await read();
  const items = [...first.items];
  let nextCursor = first.nextCursor;
  const seen = new Set<string>();
  for (let i = 1; i < pages && nextCursor !== undefined; i++) {
    if (seen.has(nextCursor)) throw new ApiError('bad_response', 'Repeated channel cursor', 0);
    seen.add(nextCursor);
    const next = await read(nextCursor);
    items.push(...next.items);
    nextCursor = next.nextCursor;
  }
  return { items, nextCursor };
}

export type ChannelRow = Awaited<ReturnType<typeof channelPages>>['items'][number];
export const isOpenChannel = (row: ChannelRow) => 'local' in row;
export const channelRef = (row: ChannelRow) => row.shortChannelId ?? row.fundingOutpoint;
export const channelsQuery = (api: ApiClient, nodeId: string, pages: number, closed: boolean) =>
  queryOptions({
    queryKey: [closed ? 'closed-channels' : 'channels', nodeId, pages],
    queryFn: () => channelPages(api, nodeId, pages, closed),
  });

export const channelQuery = (api: ApiClient, nodeId: string, channel: string) =>
  queryOptions({
    queryKey: ['channel', nodeId, channel],
    queryFn: async (): Promise<ChannelRow> => {
      try {
        return await api.call('channel', { params: { nodeId, channel } });
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'not_found') throw error;
        const closed = await channelPages(api, nodeId, 50, true);
        const found = closed.items.find(
          (row) => row.id === channel || row.shortChannelId === channel || row.fundingOutpoint === channel,
        );
        if (found) return found;
        throw error;
      }
    },
  });

export function filterChannels(rows: ChannelRow[], state: string, q: string, sort: string): ChannelRow[] {
  const text = q.trim().toLowerCase();
  const field = sort.replace(/^-/, '');
  const direction = sort.startsWith('-') ? -1 : 1;
  const value = (row: ChannelRow): bigint =>
    BigInt(
      field === 'local'
        ? 'local' in row
          ? row.local
          : row.finalLocal
        : field === 'remote'
          ? 'remote' in row
            ? row.remote
            : '0'
          : row.capacity,
    );
  return rows
    .filter(
      (row) =>
        (state === 'all' || ('state' in row ? row.state.group : 'closed') === state) &&
        [row.id, row.shortChannelId, row.fundingOutpoint, row.peer?.pubkey, row.peer?.alias].some((s) =>
          s?.toLowerCase().includes(text),
        ),
    )
    .sort(
      (a, b) =>
        direction *
        (field === 'peer'
          ? (a.peer?.alias ?? a.peer?.pubkey ?? '').localeCompare(b.peer?.alias ?? b.peer?.pubkey ?? '')
          : value(a) < value(b)
            ? -1
            : value(a) > value(b)
              ? 1
              : 0),
    );
}
