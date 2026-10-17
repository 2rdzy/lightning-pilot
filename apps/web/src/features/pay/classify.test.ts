import { describe, expect, it } from 'vitest';
import regtest from '../../../../../packages/core/src/decode/fixtures/regtest-requests.json' with { type: 'json' };
import { classifyRequest } from './classify.ts';

// Invoices made on real regtest nodes of each chain (fixture chain names: blake2b, sha256d).
function invoice(chain: 'blake2b' | 'sha256d'): string {
  const found = regtest.invoices.find((i) => i.chain === chain && i.amountMsat !== null && i.implementation === 'cln');
  if (!found) throw new Error('no fixture');
  return found.bolt11;
}
function address(chain: 'blake2b' | 'sha256d'): string {
  const found = regtest.addresses.find((a) => a.chain === chain && a.bitcoinType === 'bech32');
  if (!found) throw new Error('no fixture');
  return found.address;
}
// The secp256k1 generator point: a valid public key.
const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

describe('classifyRequest (universal pay input)', () => {
  it('sends a BOLT11 invoice of the node chain to the preview as pasted, with or without lightning:', () => {
    const bolt11 = invoice('blake2b');
    expect(classifyRequest(`  ${bolt11} `, 'blake2b', 'regtest')).toEqual({ kind: 'invoice', bolt11 });
    expect(classifyRequest(`lightning:${bolt11}`, 'blake2b', 'regtest')).toEqual({
      kind: 'invoice',
      bolt11: `lightning:${bolt11}`,
    });
    expect(classifyRequest(invoice('sha256d'), 'bitcoin', 'regtest').kind).toBe('invoice');
  });

  it('leaves an invoice the browser refuses to the server, which gives the reason', () => {
    // A stock invoice on a BLAKE2b node: the browser sees wrong_chain, the server refuses it with that reason.
    expect(classifyRequest(invoice('sha256d'), 'blake2b', 'regtest')).toEqual({
      kind: 'invoice',
      bolt11: invoice('sha256d'),
    });
    expect(classifyRequest('lnbcrt1garbage', 'blake2b', 'regtest').kind).toBe('invoice');
  });

  it('takes the invoice out of a bitcoin: URI and keeps its label and message as text', () => {
    const bolt11 = invoice('blake2b');
    expect(classifyRequest(`bitcoin:?lightning=${bolt11}&label=Shop&message=Order%2042`, 'blake2b', 'regtest')).toEqual(
      { kind: 'invoice', bolt11, label: 'Shop', message: 'Order 42' },
    );
    expect(classifyRequest(`BITCOIN:${address('blake2b')}?lightning=${bolt11}`, 'blake2b', 'regtest')).toEqual({
      kind: 'invoice',
      bolt11,
    });
  });

  it('refuses a URI whose invoice is for the other chain or disagrees with its amount', () => {
    expect(classifyRequest(`bitcoin:?lightning=${invoice('sha256d')}`, 'blake2b', 'regtest')).toEqual({
      kind: 'invalid',
      reason: 'wrong_chain',
    });
    // The fixture invoice is for 1000 msat; the URI claims 1 coin.
    expect(classifyRequest(`bitcoin:?amount=1&lightning=${invoice('blake2b')}`, 'blake2b', 'regtest')).toEqual({
      kind: 'invalid',
      reason: 'inconsistent',
    });
  });

  it('points addresses and URIs without an invoice to on-chain sending', () => {
    expect(classifyRequest(address('blake2b'), 'blake2b', 'regtest')).toEqual({ kind: 'onchain' });
    expect(classifyRequest(`bitcoin:${address('sha256d')}?amount=0.001`, 'bitcoin', 'regtest')).toEqual({
      kind: 'onchain',
    });
    expect(classifyRequest('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'bitcoin', 'regtest')).toEqual({
      kind: 'invalid',
      reason: 'wrong_network',
    });
  });

  it('recognises node URIs, and what this release cannot pay', () => {
    expect(classifyRequest(`${PUBKEY}@127.0.0.1:9735`, 'blake2b', 'regtest')).toEqual({
      kind: 'node',
      uri: `${PUBKEY}@127.0.0.1:9735`,
    });
    expect(classifyRequest('satoshi@example.com', 'blake2b', 'regtest')).toEqual({ kind: 'unsupported' });
    expect(classifyRequest('lnurlp://example.com/pay', 'blake2b', 'regtest')).toEqual({ kind: 'unsupported' });
    expect(classifyRequest('lno1qcp4256ypq', 'blake2b', 'regtest')).toEqual({ kind: 'unsupported' });
    expect(classifyRequest('lnurl1notvalid', 'blake2b', 'regtest')).toEqual({ kind: 'invalid', reason: 'malformed' });
    expect(classifyRequest('hello there', 'blake2b', 'regtest')).toEqual({ kind: 'unknown' });
  });
});
