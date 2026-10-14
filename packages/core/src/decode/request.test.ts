import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, createBase58check } from '@scure/base';
import { decodeAddress } from './address.ts';
import { decodePaymentUri } from './bip21.ts';
import type { ChainContext } from './chain.ts';
import { DecodeError, type DecodeReason } from './errors.ts';
import { decodeNodeUri } from './node-uri.ts';
import { decodeRequest } from './request.ts';
import { bytesToWords, wordsToBytes } from './words.ts';
import bip350 from './fixtures/bip350-address-vectors.json' with { type: 'json' };
import regtest from './fixtures/regtest-requests.json' with { type: 'json' };
import { BASE_FIELDS, signInvoice } from './fixtures/sign.ts';

const BLAKE2B: ChainContext = { network: 'regtest', invoiceBit512: 'required' };
const BITCOIN: ChainContext = { network: 'regtest', invoiceBit512: 'refused' };
const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

function reasonOf(fn: () => unknown): DecodeReason | 'accepted' | 'other error' {
  try {
    fn();
    return 'accepted';
  } catch (err) {
    return err instanceof DecodeError ? err.reason : 'other error';
  }
}

function invoice(chain: 'blake2b' | 'sha256d', amount: string | null, implementation = 'cln') {
  const found = regtest.invoices.find(
    (i) => i.chain === chain && i.amountMsat === amount && i.implementation === implementation && i.description,
  );
  if (!found) throw new Error('no fixture');
  return found;
}

describe('decodeAddress', () => {
  const TYPES = { legacy: 'p2pkh', 'p2sh-segwit': 'p2sh', bech32: 'p2wpkh', bech32m: 'p2tr' } as const;

  it.each(regtest.addresses)('accepts the $chain $bitcoinType address on regtest only', (fixture) => {
    const decoded = decodeAddress(fixture.address, 'regtest');
    expect(decoded.type).toBe(TYPES[fixture.bitcoinType as keyof typeof TYPES]);
    expect(decoded.network).toBe('regtest');
    expect(reasonOf(() => decodeAddress(fixture.address, 'mainnet'))).toBe('wrong_network');
  });

  it('cannot tell regtest base58 addresses from testnet4 and signet ones (same version bytes)', () => {
    const legacy = regtest.addresses.find((a) => a.bitcoinType === 'legacy');
    if (!legacy) throw new Error('no fixture');
    expect(decodeAddress(legacy.address, 'testnet4').type).toBe('p2pkh');
    expect(decodeAddress(legacy.address, 'signet').type).toBe('p2pkh');
    const segwit = regtest.addresses.find((a) => a.bitcoinType === 'bech32');
    if (!segwit) throw new Error('no fixture');
    expect(reasonOf(() => decodeAddress(segwit.address, 'testnet4'))).toBe('wrong_network');
  });

  it.each(bip350.valid)(
    'BIP350 valid address $address is accepted or reported as unsupported',
    ({ address, scriptPubKey }) => {
      const network = address.toLowerCase().startsWith('bc1') ? 'mainnet' : 'testnet4';
      const version = parseInt(scriptPubKey.slice(0, 2), 16);
      const length = parseInt(scriptPubKey.slice(2, 4), 16);
      const sendable = (version === 0 && (length === 20 || length === 32)) || (version === 0x51 && length === 32);
      const reason = reasonOf(() => decodeAddress(address, network));
      expect(reason).toBe(sendable ? 'accepted' : 'unsupported');
      if (sendable) expect(decodeAddress(address, network).address).toBe(address.toLowerCase());
    },
  );

  it.each(bip350.invalid)('BIP350 invalid address $address is refused ($reason)', ({ address, reason }) => {
    const network = address.toLowerCase().startsWith('bc1') ? 'mainnet' : 'testnet4';
    expect(reasonOf(() => decodeAddress(address, network))).toBe(
      reason === 'Invalid human-readable part' ? 'unknown_prefix' : 'malformed',
    );
  });

  it('gives the output script that pays each kind of address (BIP173, BIP350 vectors)', () => {
    expect(decodeAddress('1RustyRX2oai4EYYDpQGWvEL62BBGqN9T', 'mainnet').script).toBe(
      '76a91404b61f7dc1ea0dc99424464cc4064dc564d91e8988ac',
    );
    expect(decodeAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'mainnet').script).toBe(
      '0014751e76e8199196d454941c45d1b3a323f1433bd6',
    );
    expect(decodeAddress('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', 'mainnet').script).toBe(
      '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262',
    );
    expect(decodeAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'mainnet').script).toBe(
      '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    );
  });

  it('checks base58 addresses: checksum, length, version and network', () => {
    expect(decodeAddress('1RustyRX2oai4EYYDpQGWvEL62BBGqN9T', 'mainnet').type).toBe('p2pkh');
    expect(decodeAddress(' 3EktnHQD7RiAE6uzMj2ZifT9YgRrkSgzQX ', 'mainnet')).toEqual({
      address: '3EktnHQD7RiAE6uzMj2ZifT9YgRrkSgzQX',
      type: 'p2sh',
      network: 'mainnet',
      script: 'a9148f55563b9a19f321c211e9b9f38cdf686ea0784587',
    });
    expect(reasonOf(() => decodeAddress('1RustyRX2oai4EYYDpQGWvEL62BBGqN9U', 'mainnet'))).toBe('malformed');
    expect(reasonOf(() => decodeAddress('1RustyRX2oai4EYYDpQGWvEL62BBGqN9T', 'regtest'))).toBe('wrong_network');
    const b58 = createBase58check(sha256);
    expect(reasonOf(() => decodeAddress(b58.encode(Uint8Array.of(48, ...new Uint8Array(20))), 'mainnet'))).toBe(
      'unknown_prefix',
    );
    expect(reasonOf(() => decodeAddress(b58.encode(Uint8Array.of(0, ...new Uint8Array(19))), 'mainnet'))).toBe(
      'malformed',
    );
    expect(reasonOf(() => decodeAddress('0OIl', 'mainnet'))).toBe('malformed');
  });

  it('reports a valid bech32 string with another prefix as an unknown prefix', () => {
    const litecoin = bech32.encode('ltc', [0, ...bytesToWords(new Uint8Array(20))]);
    expect(reasonOf(() => decodeAddress(litecoin, 'mainnet'))).toBe('unknown_prefix');
  });
});

describe('decodePaymentUri (BIP21 / BIP321)', () => {
  const address = regtest.addresses.find((a) => a.chain === 'blake2b' && a.bitcoinType === 'bech32')?.address ?? '';

  it('reads address, amount, label and message, with any case of scheme and keys', () => {
    const uri = decodePaymentUri(
      `BITCOIN:${address}?AMOUNT=20.3&Label=Luke-Jr&message=Donation%20for%20project%20xyz`,
      BLAKE2B,
    );
    expect(uri.address?.address).toBe(address);
    expect(uri.amount).toBe(2_030_000_000_000n);
    expect(uri.label).toBe('Luke-Jr');
    expect(uri.message).toBe('Donation for project xyz');
  });

  it.each([
    ['50', 5_000_000_000_000n],
    ['0.00000001', 1000n],
    ['.5', 50_000_000_000n],
    ['1.', 100_000_000_000n],
    ['21000000', 2_100_000_000_000_000_000n],
  ])('reads amount=%s as %s msat', (amount, expected) => {
    expect(decodePaymentUri(`bitcoin:${address}?amount=${amount}`, BLAKE2B).amount).toBe(expected);
  });

  it.each(['50,000.00', '0.000000001', '0', '', '.', '21000000.00000001', '1e3', '-1'])(
    'refuses amount=%s',
    (amount) => {
      expect(reasonOf(() => decodePaymentUri(`bitcoin:${address}?amount=${amount}`, BLAKE2B))).toBe('invalid_amount');
    },
  );

  it('checks the embedded invoice for the chain and takes its amount', () => {
    const fixture = invoice('blake2b', '12345678');
    const uri = decodePaymentUri(`bitcoin:${address}?lightning=${fixture.bolt11.toUpperCase()}`, BLAKE2B);
    expect(uri.lightning?.paymentHash).toBe(fixture.paymentHash);
    expect(uri.amount).toBe(12_345_678n);
    expect(reasonOf(() => decodePaymentUri(`bitcoin:?lightning=${fixture.bolt11}`, BITCOIN))).toBe('wrong_chain');
    expect(decodePaymentUri(`bitcoin:?lightning=${fixture.bolt11}`, BLAKE2B).address).toBeUndefined();
  });

  it('refuses an amount that differs from the invoice amount, and keeps it for an amountless invoice', () => {
    const fixed = invoice('blake2b', '12345678');
    expect(reasonOf(() => decodePaymentUri(`bitcoin:?amount=1&lightning=${fixed.bolt11}`, BLAKE2B))).toBe(
      'inconsistent',
    );
    // 12,345.678 sat: the URI can only carry whole satoshis, rounded either way.
    for (const rounded of ['0.00012345', '0.00012346']) {
      expect(decodePaymentUri(`bitcoin:?amount=${rounded}&lightning=${fixed.bolt11}`, BLAKE2B).amount).toBe(
        12_345_678n,
      );
    }
    expect(reasonOf(() => decodePaymentUri(`bitcoin:?amount=0.00012347&lightning=${fixed.bolt11}`, BLAKE2B))).toBe(
      'inconsistent',
    );
    expect(reasonOf(() => decodePaymentUri(`bitcoin:?amount=0.00012344&lightning=${fixed.bolt11}`, BLAKE2B))).toBe(
      'inconsistent',
    );
    const open = invoice('blake2b', null);
    expect(decodePaymentUri(`bitcoin:?amount=0.001&lightning=${open.bolt11}`, BLAKE2B).amount).toBe(100_000_000n);
  });

  it('refuses required keys it does not implement and ignores other unknown keys', () => {
    expect(reasonOf(() => decodePaymentUri(`bitcoin:${address}?req-somethingyoudontunderstand=50`, BLAKE2B))).toBe(
      'unsupported',
    );
    expect(reasonOf(() => decodePaymentUri(`bitcoin:${address}?req-pop=callback%3a`, BLAKE2B))).toBe('unsupported');
    expect(
      decodePaymentUri(`bitcoin:${address}?somethingyoudontunderstand=50&pop=callback%3a&&`, BLAKE2B).address,
    ).toBeDefined();
  });

  it('refuses repeated label, message, amount and pop keys, and bad percent-encoding', () => {
    expect(reasonOf(() => decodePaymentUri(`bitcoin:${address}?label=a&LABEL=b`, BLAKE2B))).toBe('malformed');
    expect(reasonOf(() => decodePaymentUri(`bitcoin:${address}?amount=1&amount=2`, BLAKE2B))).toBe('malformed');
    expect(reasonOf(() => decodePaymentUri(`bitcoin:${address}?message=%E0%A4%A`, BLAKE2B))).toBe('malformed');
  });

  it('needs an address or an invoice; offers and silent payments alone are unsupported', () => {
    expect(reasonOf(() => decodePaymentUri('bitcoin:?lno=lno1bogusoffer', BLAKE2B))).toBe('unsupported');
    expect(reasonOf(() => decodePaymentUri('bitcoin:?sp=sp1qsilentpayment', BLAKE2B))).toBe('unsupported');
    expect(reasonOf(() => decodePaymentUri('bitcoin:?label=nothing', BLAKE2B))).toBe('malformed');
    expect(reasonOf(() => decodePaymentUri('bitcoin:', BLAKE2B))).toBe('malformed');
    expect(reasonOf(() => decodePaymentUri(address, BLAKE2B))).toBe('malformed');
    const withOffer = decodePaymentUri(`bitcoin:${address}?lno=lno1bogusoffer`, BLAKE2B);
    expect(withOffer.offer).toBe('lno1bogusoffer');
  });

  it('checks the address for the node network', () => {
    expect(reasonOf(() => decodePaymentUri('bitcoin:1RustyRX2oai4EYYDpQGWvEL62BBGqN9T', BLAKE2B))).toBe(
      'wrong_network',
    );
  });
});

describe('decodeNodeUri', () => {
  it.each([
    [PUBKEY, { pubkey: PUBKEY }],
    [`${PUBKEY.toUpperCase()}@127.0.0.1:19110`, { pubkey: PUBKEY, host: '127.0.0.1', port: 19110 }],
    [`${PUBKEY}@[::1]:9735`, { pubkey: PUBKEY, host: '[::1]', port: 9735 }],
    [`${PUBKEY}@[2001:DB8::1]`, { pubkey: PUBKEY, host: '[2001:db8::1]', port: 9735 }],
    [`${PUBKEY}@Node.Example.com`, { pubkey: PUBKEY, host: 'node.example.com', port: 9735 }],
    [`${PUBKEY}@${'a'.repeat(56)}.onion:9735`, { pubkey: PUBKEY, host: `${'a'.repeat(56)}.onion`, port: 9735 }],
  ])('reads %s', (input, expected) => {
    expect(decodeNodeUri(input)).toEqual(expected);
  });

  it.each([
    `02${'ff'.repeat(32)}`,
    `04${'11'.repeat(32)}`,
    `${PUBKEY}@localhost:9735`,
    `${PUBKEY}@1.2.3.256:9735`,
    `${PUBKEY}@host.example.com:0`,
    `${PUBKEY}@host.example.com:65536`,
    `${PUBKEY}@host.example.com:port`,
    `${PUBKEY}@[not-ipv6]:9735`,
    `${PUBKEY}@-bad.example.com`,
    `${PUBKEY}@`,
  ])('refuses %s', (input) => {
    expect(reasonOf(() => decodeNodeUri(input))).toBe('malformed');
  });
});

describe('decodeRequest (universal input)', () => {
  it('decodes BOLT11 invoices with or without the lightning: scheme, checked for the chain', () => {
    const fixture = invoice('sha256d', '1000', 'lnd');
    const decoded = decodeRequest(`  lightning:${fixture.bolt11}  `, BITCOIN);
    expect(decoded).toMatchObject({
      kind: 'bolt11',
      supported: true,
      network: 'regtest',
      payee: fixture.payee,
      amount: 1000n,
      paymentHash: fixture.paymentHash,
      description: 'fixture',
    });
    expect(decoded.raw).toBe(`lightning:${fixture.bolt11}`);
    expect(reasonOf(() => decodeRequest(fixture.bolt11, BLAKE2B))).toBe('wrong_chain');
    expect(reasonOf(() => decodeRequest(fixture.bolt11.slice(0, -1), BITCOIN))).toBe('malformed');
  });

  it('decodes payment links and gives the invoice fields first', () => {
    const fixture = invoice('blake2b', '1000');
    const address = regtest.addresses.find((a) => a.chain === 'blake2b' && a.bitcoinType === 'bech32m')?.address ?? '';
    const both = decodeRequest(`bitcoin:${address}?lightning=${fixture.bolt11}&message=hi`, BLAKE2B);
    expect(both).toMatchObject({ kind: 'bip21', payee: fixture.payee, amount: 1000n, description: 'fixture' });
    const onchain = decodeRequest(`bitcoin:${address}?amount=0.5&message=rent`, BLAKE2B);
    expect(onchain).toMatchObject({ kind: 'bip21', network: 'regtest', amount: 50_000_000_000n, description: 'rent' });
    expect(decodeRequest(`bitcoin:${address}`, BLAKE2B).description).toBe('');
  });

  it('decodes on-chain addresses for the node network', () => {
    for (const fixture of regtest.addresses) {
      expect(decodeRequest(fixture.address, BLAKE2B)).toMatchObject({ kind: 'onchain-address', network: 'regtest' });
    }
    expect(reasonOf(() => decodeRequest('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', BLAKE2B))).toBe('wrong_network');
    expect(reasonOf(() => decodeRequest('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', BLAKE2B))).toBe('malformed');
  });

  it('recognises node URIs, Lightning addresses and LNURLs without contacting anything', () => {
    expect(decodeRequest(`${PUBKEY}@127.0.0.1:9735`, BLAKE2B)).toMatchObject({ kind: 'node-uri', payee: PUBKEY });
    expect(decodeRequest('Satoshi@Example.com', BLAKE2B)).toMatchObject({
      kind: 'lightning-address',
      user: 'satoshi',
      domain: 'example.com',
    });
    const url = 'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df';
    const lnurl = bech32.encode('lnurl', bytesToWords(new TextEncoder().encode(url)), false).toUpperCase();
    expect(decodeRequest(`lightning:${lnurl}`, BLAKE2B)).toMatchObject({ kind: 'lnurl', url, supported: true });
    expect(decodeRequest('lnurlp://service.com/pay/1', BLAKE2B)).toMatchObject({ url: 'https://service.com/pay/1' });
    // The scheme in any case; the rest keeps its case.
    expect(decodeRequest('LNURLP://service.com/Pay/1', BLAKE2B)).toMatchObject({ url: 'https://service.com/Pay/1' });
    expect(decodeRequest('KeyAuth://service.com/a', BLAKE2B)).toMatchObject({ url: 'https://service.com/a' });
    const onion = `lnurlw://${'a'.repeat(56)}.onion/w`;
    expect(decodeRequest(onion, BLAKE2B)).toMatchObject({ url: `http://${'a'.repeat(56)}.onion/w` });
    expect(reasonOf(() => decodeRequest('lnurl1qqqqqqqq', BLAKE2B))).toBe('malformed');
    const padded = bech32.encode('lnurl', [...bytesToWords(new TextEncoder().encode(url)), 31], false);
    expect(reasonOf(() => decodeRequest(padded, BLAKE2B))).toBe('malformed');
    expect(decodeRequest(`keyauth://${'b'.repeat(56)}.onion`, BLAKE2B)).toMatchObject({
      url: `http://${'b'.repeat(56)}.onion/`,
    });
    const notUrl = bech32.encode('lnurl', bytesToWords(new TextEncoder().encode('not a url')), false);
    expect(reasonOf(() => decodeRequest(notUrl, BLAKE2B))).toBe('malformed');
  });

  it('recognises BOLT12 strings and reports them as not supported', () => {
    expect(decodeRequest('lno1pqps7sjqpgtyzm3qv4uxzmtsd3jjqer9wd3hy6tsw35k7m3qdsenzxqp', BLAKE2B)).toMatchObject({
      kind: 'bolt12-offer',
      supported: false,
    });
    expect(decodeRequest('LNI1QQQQ+ QQQQ', BLAKE2B)).toMatchObject({ kind: 'bolt12-invoice', supported: false });
    expect(decodeRequest('lnr1qqqq', BLAKE2B)).toMatchObject({ kind: 'unknown', supported: false });
  });

  it('returns kind unknown for text it does not recognise', () => {
    for (const text of ['', 'hello', 'https://example.com', '12345', 'user@localhost']) {
      expect(decodeRequest(text, BLAKE2B)).toMatchObject({ kind: 'unknown', supported: false, description: '' });
    }
  });

  it('decodes an invoice signed by us with the chain bit for the BLAKE2b profile', async () => {
    const signed = await signInvoice('lnbcrt10u', BASE_FIELDS([], [8, 14, 17, 512]));
    expect(decodeRequest(signed, BLAKE2B)).toMatchObject({ kind: 'bolt11', amount: 1_000_000n });
    expect(reasonOf(() => decodeRequest(signed, BITCOIN))).toBe('wrong_chain');
  });
});

describe('words', () => {
  it('refuses set padding bits and round-trips bytes', () => {
    const bytes = Uint8Array.of(1, 2, 3, 250);
    expect(wordsToBytes(bytesToWords(bytes))).toEqual(bytes);
    const words = bytesToWords(bytes);
    words[words.length - 1] = 31;
    expect(wordsToBytes(words)).toBeUndefined();
  });
});
