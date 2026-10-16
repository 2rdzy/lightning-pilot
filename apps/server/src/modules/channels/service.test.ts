import { describe, expect, it } from 'vitest';
import {
  msat,
  parseChannelId,
  parseFundingOutpoint,
  parsePubkey,
  parseShortChannelId,
  parseTxid,
  untrustedText,
  type Channel,
} from '@lightning-pilot/core';
import { channelJson, closedChannelJson, replayableOnOtherChain } from './service.ts';

const channel: Channel = {
  id: parseChannelId('cd'.repeat(32)),
  peer: { pubkey: parsePubkey('02' + 'aa'.repeat(32)) },
  state: { group: 'opening', native: 'CHANNELD_AWAITING_LOCKIN', nativeLabel: 'Waiting' },
  opener: 'remote',
  private: true,
  capacity: msat(2000n),
  local: msat(0n),
  remote: msat(2000n),
  spendable: msat(0n),
  receivable: msat(1000n),
  reserves: { ours: msat(10n), theirs: msat(10n) },
  fundingOutpoint: parseFundingOutpoint(`${'ef'.repeat(32)}:1`),
  channelType: ['static_remotekey/even', 'anchors/even', 'unified_sigs/even'],
  stats: { inFulfilled: msat(0n), outFulfilled: msat(0n), inPayments: 0, outPayments: 0 },
};

describe('channel records', () => {
  it('derives replay protection from the channel type on BLAKE2b only', () => {
    expect(replayableOnOtherChain('blake2b', channel)).toBe(false);
    expect(replayableOnOtherChain('blake2b', { ...channel, channelType: ['anchors/even'] })).toBe(true);
    expect(replayableOnOtherChain('bitcoin', { ...channel, channelType: ['anchors/even'] })).toBe(false);
  });

  it('leaves out what an opening channel does not have yet, and maps it once it has it', () => {
    const opening = channelJson('blake2b', channel);
    expect(opening).not.toHaveProperty('shortChannelId');
    expect(opening).not.toHaveProperty('policy');
    expect(opening).not.toHaveProperty('closeTo');
    const open = channelJson('bitcoin', {
      ...channel,
      shortChannelId: parseShortChannelId('103x1x0'),
      peer: { ...channel.peer, alias: untrustedText('bob') },
      policy: { baseFeeMsat: msat(1000n), feePpm: 10, minHtlcMsat: msat(1n), maxHtlcMsat: msat(2000n), cltvDelta: 34 },
      closeTo: 'bcrt1qexample',
    });
    expect(open).toMatchObject({
      shortChannelId: '103x1x0',
      peer: { alias: 'bob' },
      policy: { baseFeeMsat: '1000', maxHtlcMsat: '2000' },
      closeTo: 'bcrt1qexample',
    });
  });

  it('maps closed channels with and without the optional node fields', () => {
    const base = {
      id: channel.id,
      capacity: msat(2000n),
      finalLocal: msat(500n),
      closeCause: 'remote' as const,
      closeCauseRaw: 'remote',
      fundingOutpoint: channel.fundingOutpoint,
    };
    expect(Object.keys(closedChannelJson(base)).sort()).toEqual(
      ['capacity', 'closeCause', 'closeCauseRaw', 'finalLocal', 'fundingOutpoint', 'id'].sort(),
    );
    expect(
      closedChannelJson({
        ...base,
        shortChannelId: parseShortChannelId('103x1x0'),
        peer: { pubkey: channel.peer.pubkey, alias: untrustedText('bob') },
        closingTxid: parseTxid('12'.repeat(32)),
        closedAt: '2026-10-16T10:00:00.000Z',
      }),
    ).toMatchObject({ shortChannelId: '103x1x0', peer: { alias: 'bob' }, closingTxid: '12'.repeat(32) });
  });
});
