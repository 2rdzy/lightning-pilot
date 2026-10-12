// Identifiers with a fixed shape, as branded strings. Only these parsers create them, so a value typed `Txid` or
// `PaymentHash` has been checked; the logger keeps such fields unredacted only because of that (a preimage has the
// same shape as a txid, so it must never be passable where a txid is expected).
import { z } from 'zod';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type PaymentHash = Brand<string, 'PaymentHash'>;
export type Txid = Brand<string, 'Txid'>;
export type ChannelId = Brand<string, 'ChannelId'>;
export type Pubkey = Brand<string, 'Pubkey'>;
export type FundingOutpoint = Brand<string, 'FundingOutpoint'>;

const HEX32 = /^[0-9a-f]{64}$/;
const PUBKEY = /^0[23][0-9a-f]{64}$/;
const OUTPOINT = /^[0-9a-f]{64}:[0-9]{1,10}$/;

export class IdError extends Error {}

function check<T>(pattern: RegExp, what: string) {
  return (value: string): T => {
    if (!pattern.test(value)) throw new IdError(`not a ${what}`);
    return value as T;
  };
}

export const parsePaymentHash = check<PaymentHash>(HEX32, 'payment hash');
export const parseTxid = check<Txid>(HEX32, 'txid');
export const parseChannelId = check<ChannelId>(HEX32, 'channel id');
export const parsePubkey = check<Pubkey>(PUBKEY, 'node public key');
export const parseFundingOutpoint = check<FundingOutpoint>(OUTPOINT, 'funding outpoint');

export const ID_PATTERNS = {
  paymentHash: HEX32,
  txid: HEX32,
  channelId: HEX32,
  pubkey: PUBKEY,
  fundingOutpoint: OUTPOINT,
};

export const PubkeySchema = z.string().regex(PUBKEY).meta({ description: 'Node public key (33 bytes, hex)' });
export const PaymentHashSchema = z.string().regex(HEX32).meta({ description: 'Payment hash (32 bytes, hex)' });
export const UuidSchema = z.uuid();
