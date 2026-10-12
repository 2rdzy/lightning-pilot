// Schemas for the parts of CLN's replies the adapter uses. A buggy or compromised node must not crash or mislead
// the server, so every field used is checked; fields we do not use are ignored (newer CLN versions add some).
// Amounts arrive as bigint from the lossless parser.
import { z } from 'zod';

const msat = z.bigint().nonnegative();
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);

export const GetInfo = z.object({
  id: z.string().regex(/^0[23][0-9a-f]{64}$/),
  alias: z.string().optional(),
  color: z.string().regex(/^[0-9a-f]{6}$/),
  version: z.string().max(200),
  network: z.string().max(50),
  blockheight: z.int().nonnegative(),
  num_peers: z.int().nonnegative(),
  num_active_channels: z.int().nonnegative(),
  num_pending_channels: z.int().nonnegative(),
  num_inactive_channels: z.int().nonnegative(),
  our_features: z.object({ init: z.string().regex(/^([0-9a-f]{2})*$/) }),
  warning_bitcoind_sync: z.string().optional(),
  warning_lightningd_sync: z.string().optional(),
});

export const RawBlock = z.object({ blockhash: z.string().optional(), block: z.string().regex(/^([0-9a-f]{2})+$/) });

export const ListFunds = z.object({
  outputs: z.array(
    z.object({
      amount_msat: msat,
      status: z.string(),
      reserved: z.boolean().optional(),
    }),
  ),
});

export const ListPeerChannels = z.object({
  channels: z.array(
    z.object({
      state: z.string(),
      peer_connected: z.boolean().optional(),
      to_us_msat: msat.optional(),
      total_msat: msat.optional(),
      spendable_msat: msat.optional(),
      receivable_msat: msat.optional(),
    }),
  ),
});

export const InvoiceReply = z.object({
  bolt11: z.string(),
  payment_hash: hex32,
  expires_at: z.int().nonnegative(),
});

export const XpayReply = z.object({
  payment_preimage: hex32,
  amount_msat: msat,
  amount_sent_msat: msat,
});

export const ListSendPays = z.object({
  payments: z.array(
    z.object({
      payment_hash: hex32,
      status: z.string(),
      amount_msat: msat.optional(),
      amount_sent_msat: msat.optional(),
      payment_preimage: hex32.optional(),
      label: z.string().optional(),
    }),
  ),
});
