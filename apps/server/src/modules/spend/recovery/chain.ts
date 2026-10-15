// Resolves `unknown` on-chain sends, channel opens and channel closes from the node's wallet and channel lists
// (spend policy §4). A spend is called failed only when the node shows that nothing left: an on-chain send whose
// transaction the wallet does not know and whose inputs are all still unspent, a channel open with no matching
// channel, a close whose channel is still open. Anything unclear stays unknown and counted.
import {
  AdapterError,
  parseChannelId,
  parseTxid,
  readPsbt,
  toMsatString,
  type Channel,
  type ChannelId,
  type ClosedChannel,
  type Msat,
  type NodeAdapter,
  type Page,
  type PageRequest,
  type Txid,
} from '@lightning-pilot/core';
import type { Db } from '../../../storage/db.ts';
import type { Logger } from '../../../logging/logger.ts';
import type { Vault } from '../../vault/index.ts';
import { INTERRUPTED, SETTLE_FAILED_AFTER_MS } from './bolt11.ts';

// `fundchannel` negotiates with the peer before the channel gets an id the node lists, and that may take longer than
// a payment's retry window; a channel open is called failed only this long after its last update.
export const OPEN_SETTLE_FAILED_AFTER_MS = 600_000;

export interface UnknownChainSpend {
  id: string;
  chain: string;
  pubkey: string;
  type: 'onchain' | 'channel-open' | 'channel-close';
  amount_msat: string;
  updated_at: string;
  error_code: string | null;
  txid: string | null;
  psbt_key_id: string | null;
  psbt_nonce: Uint8Array | null;
  psbt_ciphertext: Uint8Array | null;
  channel_id: string | null;
  peer: string | null;
}

type Settled = 'succeeded' | 'failed' | 'unknown';
interface Resolution {
  state: 'succeeded' | 'failed';
  errorCode?: string;
  fee?: Msat;
  txid?: Txid;
  channelId?: ChannelId;
}

export async function settleChainSpend(
  db: Db,
  adapter: NodeAdapter,
  vault: Vault,
  intent: UnknownChainSpend,
  now: Date,
  log: Logger,
): Promise<Settled> {
  const age = now.getTime() - Date.parse(intent.updated_at);
  let resolution: Resolution | undefined;
  try {
    if (intent.type === 'onchain') resolution = await onchain(adapter, vault, intent, age, log);
    else if (intent.type === 'channel-open') resolution = await channelOpen(db, adapter, intent, age);
    else resolution = await channelClose(adapter, intent, age);
  } catch (err) {
    log.warn('spend status not readable', {
      intentId: intent.id,
      type: intent.type,
      code: err instanceof AdapterError ? err.code : 'internal',
    });
    return 'unknown';
  }
  if (resolution === undefined) return 'unknown';
  const result = await db
    .updateTable('spend_intents')
    .set({
      state: resolution.state,
      ...(resolution.fee === undefined ? {} : { fee_msat: toMsatString(resolution.fee) }),
      ...(resolution.txid === undefined ? {} : { txid: resolution.txid }),
      ...(resolution.channelId === undefined ? {} : { channel_id: resolution.channelId }),
      ...(resolution.errorCode === undefined
        ? intent.error_code === INTERRUPTED
          ? { error_code: null }
          : {}
        : { error_code: resolution.errorCode }),
      // The sealed PSBT is needed only while the outcome is unknown.
      psbt_key_id: null,
      psbt_nonce: null,
      psbt_ciphertext: null,
      updated_at: now.toISOString(),
    })
    .where('id', '=', intent.id)
    .where('state', '=', 'unknown')
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    const stored = await db.selectFrom('spend_intents').select('state').where('id', '=', intent.id).executeTakeFirst();
    return stored?.state === 'succeeded' || stored?.state === 'failed' ? stored.state : 'unknown';
  }
  log.info('spend settled', {
    intentId: intent.id,
    security: true,
    type: intent.type,
    state: resolution.state,
    ...(resolution.txid === undefined ? {} : { txid: resolution.txid }),
    ...(resolution.channelId === undefined ? {} : { channelId: resolution.channelId }),
    ...(resolution.fee === undefined ? {} : { feeMsat: toMsatString(resolution.fee) }),
  });
  return resolution.state;
}

async function all<T>(list: (page?: PageRequest) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

// The stored PSBT, or undefined when there is none or it cannot be opened (sealed under another vault key): a sent
// transaction is still recognised by its txid, but unsent inputs cannot be released and the intent stays unknown.
function sealedPsbt(vault: Vault, intent: UnknownChainSpend, log: Logger) {
  if (intent.psbt_key_id === null || intent.psbt_nonce === null || intent.psbt_ciphertext === null) return undefined;
  try {
    const psbt = vault.openSecret(
      { key_id: intent.psbt_key_id, nonce: intent.psbt_nonce, ciphertext: intent.psbt_ciphertext },
      `intent_psbt:${intent.id}`,
    );
    return { psbt, summary: readPsbt(psbt) };
  } catch {
    log.warn('spend PSBT not readable', { intentId: intent.id });
    return undefined;
  }
}

// The txid and the sealed PSBT are stored before `txsend` (chain.ts). Without them `txsend` was never called. With
// them: CLN adds a transaction to the wallet's list when it broadcasts it (`sendpsbt`), so a listed txid was sent;
// an unlisted one whose inputs are all still unspent coins of the wallet was not, and its inputs are released.
async function onchain(
  adapter: NodeAdapter,
  vault: Vault,
  intent: UnknownChainSpend,
  age: number,
  log: Logger,
): Promise<Resolution | undefined> {
  if (intent.txid === null)
    return intent.error_code === INTERRUPTED ? { state: 'failed', errorCode: 'not_sent' } : undefined;
  const txid = parseTxid(intent.txid);
  const sealed = sealedPsbt(vault, intent, log);
  const listed = await all((page) => adapter.onchain.listTransactions(page));
  if (listed.some((tx) => tx.txid === txid))
    return { state: 'succeeded', ...(sealed === undefined ? {} : { fee: sealed.summary.fee }) };
  // Only an interrupted intent is failed for lack of a record (as for BOLT11): an unclear answer at run time did
  // reach the node.
  if (intent.error_code !== INTERRUPTED || age < SETTLE_FAILED_AFTER_MS || sealed === undefined) return undefined;
  const { psbt, summary } = sealed;
  const coins = new Map((await adapter.onchain.listUtxos()).map((u) => [u.outpoint as string, u.status]));
  const unspent = summary.inputs.every((i) => {
    const status = coins.get(`${i.txid}:${i.vout}`);
    return status !== undefined && status !== 'spent';
  });
  if (!unspent) return undefined;
  await release(adapter, txid, psbt, intent.id, log);
  return { state: 'failed', errorCode: 'not_sent' };
}

// `txdiscard` works while the node still holds the prepared transaction; after a node restart only
// `unreserveinputs` with the PSBT does. If both fail, the node releases the reservation by itself after a while.
async function release(adapter: NodeAdapter, txid: Txid, psbt: string, intentId: string, log: Logger) {
  try {
    await adapter.onchain.discard(txid);
  } catch {
    try {
      await adapter.onchain.unreserve(psbt);
    } catch (err) {
      log.warn('spend inputs not released', {
        intentId,
        code: err instanceof AdapterError ? err.code : 'internal',
      });
    }
  }
}

// Only the peer and the amount are stored before `fundchannel`: its reply carries the channel id and funding txid.
// A channel we opened to that peer with that capacity, not already claimed by another intent, is taken as this one;
// a wrong match keeps the budget counted, never frees it.
async function channelOpen(
  db: Db,
  adapter: NodeAdapter,
  intent: UnknownChainSpend,
  age: number,
): Promise<Resolution | undefined> {
  if (intent.peer === null) return undefined;
  const claimed = new Set(
    (
      await db
        .selectFrom('spend_intents')
        .select('channel_id')
        .where('chain', '=', intent.chain)
        .where('pubkey', '=', intent.pubkey)
        .where('type', '=', 'channel-open')
        .where('channel_id', 'is not', null)
        .execute()
    ).map((r) => r.channel_id),
  );
  const amount = BigInt(intent.amount_msat);
  const ours = (c: Channel | ClosedChannel) =>
    c.peer?.pubkey === intent.peer && c.capacity === amount && !claimed.has(c.id);
  const open = (await all((page) => adapter.channel.listChannels(page))).filter((c) => c.opener === 'local' && ours(c));
  const found: Channel | ClosedChannel | undefined =
    open.find((c) => c.state.group === 'opening') ??
    open[0] ??
    (await all((page) => adapter.channel.listClosedChannels(page))).find(ours);
  if (found)
    return {
      state: 'succeeded',
      channelId: parseChannelId(found.id),
      txid: parseTxid(found.fundingOutpoint.split(':')[0] ?? ''),
    };
  if (intent.error_code !== INTERRUPTED || age < OPEN_SETTLE_FAILED_AFTER_MS) return undefined;
  return { state: 'failed', errorCode: 'not_on_node' };
}

// The channel id is stored before `close`. CLN moves the channel to CHANNELD_SHUTTING_DOWN as soon as it takes the
// command, even with the peer offline, so a channel still in normal operation never got the close.
async function channelClose(
  adapter: NodeAdapter,
  intent: UnknownChainSpend,
  age: number,
): Promise<Resolution | undefined> {
  if (intent.channel_id === null) return undefined;
  const channel = (await all((page) => adapter.channel.listChannels(page))).find((c) => c.id === intent.channel_id);
  // Gone from the list (closed, or an unopened channel the node forgot), or closing: the close was taken.
  if (channel === undefined || channel.state.group === 'closing' || channel.state.group === 'closed')
    return { state: 'succeeded' };
  if (channel.state.group !== 'active' && channel.state.group !== 'inactive') return undefined;
  if (intent.error_code !== INTERRUPTED || age < SETTLE_FAILED_AFTER_MS) return undefined;
  return { state: 'failed', errorCode: 'not_on_node' };
}
