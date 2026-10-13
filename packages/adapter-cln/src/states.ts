// CLN channel states and close causes (lightningd/channel_state_names_gen.h, CLN v26.06), mapped to our groups
// (domain and adapter §2). The owner sees the node's own state with a readable label; the group only sorts and
// counts. A state not listed here keeps its raw name and gets the group `unknown`.
import type { ChannelState, ChannelStateGroup, CloseCause } from '@lightning-pilot/core';

const STATES: Record<string, { group: ChannelStateGroup; label: string }> = {
  OPENINGD: { group: 'opening', label: 'Opening' },
  DUALOPEND_OPEN_INIT: { group: 'opening', label: 'Opening (dual funding)' },
  DUALOPEND_OPEN_COMMITTED: { group: 'opening', label: 'Opening (dual funding, committed)' },
  DUALOPEND_OPEN_COMMIT_READY: { group: 'opening', label: 'Opening (dual funding, ready to commit)' },
  DUALOPEND_AWAITING_LOCKIN: { group: 'opening', label: 'Waiting for funding confirmation' },
  CHANNELD_AWAITING_LOCKIN: { group: 'opening', label: 'Waiting for funding confirmation' },
  CHANNELD_NORMAL: { group: 'active', label: 'Normal' },
  CHANNELD_AWAITING_SPLICE: { group: 'splicing', label: 'Splicing' },
  CHANNELD_SHUTTING_DOWN: { group: 'closing', label: 'Shutting down' },
  CLOSINGD_SIGEXCHANGE: { group: 'closing', label: 'Negotiating the closing fee' },
  CLOSINGD_COMPLETE: { group: 'closing', label: 'Closing transaction published' },
  AWAITING_UNILATERAL: { group: 'closing', label: 'Force close, waiting to publish' },
  FUNDING_SPEND_SEEN: { group: 'closing', label: 'Closing transaction seen on chain' },
  ONCHAIN: { group: 'closing', label: 'Resolving outputs on chain' },
  CLOSED: { group: 'closed', label: 'Closed' },
};

export function channelState(native: string, peerConnected: boolean): ChannelState {
  const known = STATES[native];
  if (!known) return { group: 'unknown', native, nativeLabel: native };
  // A normal channel whose peer is offline can neither send nor receive.
  const group = known.group === 'active' && !peerConnected ? 'inactive' : known.group;
  return { group, native, nativeLabel: known.label };
}

// CLN's `close_cause` says who started the close, not whether it was cooperative; `user` is our own close command.
const CAUSES: Record<string, CloseCause> = {
  local: 'local',
  user: 'local',
  remote: 'remote',
  onchain: 'onchain',
  protocol: 'unknown',
  unknown: 'unknown',
};

export const closeCause = (raw: string): CloseCause => CAUSES[raw] ?? 'unknown';
