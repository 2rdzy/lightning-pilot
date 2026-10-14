// Checks shared by every spend type: session, chain identity, duplicate warning.
import { createHash } from 'node:crypto';
import { AppError, type ChainIdentityState } from '@lightning-pilot/core';
import type { Db } from '../../storage/db.ts';
import type { AuthService } from '../auth/index.ts';
import type { NodeIdentity } from './policy.ts';

export const BLOCKING = ['reserved', 'sent', 'unknown', 'succeeded'];
export const CONFIRMATION_TTL_MS = 120000;
export const MAX_LIVE_CONFIRMATIONS = 1024;
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function refuseUnlessConfirmed(identity: ChainIdentityState): void {
  if (identity.state === 'waiting') throw new AppError('chain_waiting', 'The node is not ready on its chain yet.');
  if (identity.state !== 'confirmed') throw new AppError('chain_refused', 'The node failed the chain identity check.');
}

export async function liveSession(db: Db, auth: AuthService, handle: string) {
  const row = await db.selectFrom('sessions').selectAll().where('handle', '=', handle).executeTakeFirst();
  if (!row) throw new AppError('unauthenticated', 'Please log in.');
  const live = await auth.sessions.live(db, row.id_hash);
  if (live.recovery_required === 1) throw new AppError('permission_denied', 'Complete authenticator recovery first.');
  return live;
}

// Nonfailed intents of this node identity to the same destination and amount in the last 10 minutes.
export async function duplicatesOf(
  db: Db,
  identity: NodeIdentity,
  destination: string,
  amount: string,
  now: Date,
): Promise<string[]> {
  const rows = await db
    .selectFrom('spend_intents')
    .select('id')
    .where('chain', '=', identity.chain)
    .where('pubkey', '=', identity.pubkey)
    .where('destination', '=', destination)
    .where('amount_msat', '=', amount)
    .where('state', 'in', BLOCKING)
    .where('created_at', '>', new Date(now.getTime() - 600000).toISOString())
    .where('created_at', '<=', now.toISOString())
    .orderBy('id')
    .execute();
  return rows.map((row) => row.id);
}
