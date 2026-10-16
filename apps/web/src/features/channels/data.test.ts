import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from '../../api/client.ts';
import { ListSearch, CloseSearch, filterChannels, channelPages, channelQuery, type ChannelRow } from './data.ts';
import { peerFeatures } from '../peers/data.ts';

const peer = '02' + '11'.repeat(32);
const row = (id: string, local: string): ChannelRow => ({
  id,
  peer: { pubkey: peer, alias: '<script>peer</script>' },
  state: { group: 'active', native: 'CHANNELD_NORMAL', nativeLabel: 'Active' },
  opener: 'local',
  private: false,
  capacity: local,
  local,
  remote: '0',
  spendable: local,
  receivable: '0',
  reserves: { ours: '0', theirs: '0' },
  fundingOutpoint: 'ab'.repeat(32) + ':0',
  stats: { inFulfilled: '0', outFulfilled: '0', inPayments: 0, outPayments: 0 },
  channelType: [],
  replayableOnOtherChain: true,
});

describe('channel and peer presentation data', () => {
  it('validates bounded URL state and ignores unsupported tabs/filters without acting', () => {
    expect(CloseSearch.parse({ force: 1 })).toEqual({ force: '1' });
    expect(ListSearch.parse({ q: 'x', pages: '2', state: 'active', sort: '-local' })).toEqual({
      q: 'x',
      pages: 2,
      state: 'active',
      sort: '-local',
    });
    expect(ListSearch.parse({ pages: 51, q: 'x'.repeat(201), state: 'drop', sort: 'prototype' })).toEqual({
      pages: 1,
      q: '',
      state: 'all',
      sort: '-capacity',
    });
  });
  it('sorts msat amounts above the safe-number range and searches aliases without changing the input', () => {
    const rows = [row('ab'.repeat(32), '9007199254740993'), row('cd'.repeat(32), '9007199254740992')];
    expect(filterChannels(rows, 'active', '<script>', 'local').map((r) => r.id)).toEqual([rows[1]?.id, rows[0]?.id]);
    expect(filterChannels(rows, 'opening', '', '-capacity')).toEqual([]);
    expect(rows[0]?.id).toBe('ab'.repeat(32));
  });
  it('decodes feature bits above 511 from big-endian bytes without 32-bit truncation', () => {
    expect(peerFeatures('0f' + '00'.repeat(64))).toEqual([
      'peers.feature.512',
      'peers.feature.513',
      'peers.feature.514',
      'peers.feature.515',
    ]);
    expect(peerFeatures('02' + '00'.repeat(64))).toEqual(['peers.feature.513']);
    expect(peerFeatures('00'.repeat(65))).toEqual([]);
    expect(peerFeatures(undefined)).toEqual([]);
    expect(peerFeatures('not hex')).toEqual([]);
  });
  it('loads only requested pages with typed cursor parameters and refuses a looping cursor', async () => {
    const urls: string[] = [];
    const api = new ApiClient({
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ items: [row('ab'.repeat(32), '1000')], nextCursor: 'again' }), {
          status: 200,
        });
      },
    });
    const first = await channelPages(api, 'alice', 1);
    expect(first.items).toHaveLength(1);
    await expect(channelPages(api, 'alice', 3)).rejects.toBeInstanceOf(ApiError);
    expect(urls.some((u) => u.includes('cursor=again'))).toBe(true);
  });
  it('only uses closed-channel fallback after a genuine not-found response', async () => {
    const calls: string[] = [];
    const api = new ApiClient({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify({ error: { code: 'node_unreachable', message: 'offline', requestId: 'r-node' } }),
          { status: 502 },
        );
      },
    });
    await expect(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }).fetchQuery(
        channelQuery(api, 'alice', '1x1x0'),
      ),
    ).rejects.toMatchObject({ code: 'node_unreachable' });
    expect(calls).toHaveLength(1);
  });
});
