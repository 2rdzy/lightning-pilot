import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { checkInvoiceChain } from './chain.ts';
import { DecodeError, decodeFailure, type DecodeReason } from './errors.ts';
import { decodeBolt11 } from './invoice.ts';
import spec from './fixtures/bolt11-spec-vectors.json' with { type: 'json' };
import regtest from './fixtures/regtest-requests.json' with { type: 'json' };
import {
  BASE_FIELDS,
  HASH,
  SECRET,
  TAGS,
  TEST_PUBKEY,
  bytesField,
  featureWords,
  field,
  numberWords,
  signInvoice,
  textField,
} from './fixtures/sign.ts';

const SPEC_PAYEE = '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad';
const SPEC_HASH = '0001020304050607080900010203040506070809000102030405060708090102';
const CAKE_HASH = '3925b6f67e2c340036ed12093dd44e0368df1b6ea26c53dbe4811f58fd5db8c1';

function vector(title: string): string {
  const found = [...spec.valid, ...spec.invalid].find((v) => v.title.startsWith(title));
  if (!found) throw new Error(`no vector ${title}`);
  return found.invoice;
}

function reasonOf(fn: () => unknown): DecodeReason | 'accepted' | 'other error' {
  try {
    fn();
    return 'accepted';
  } catch (err) {
    return err instanceof DecodeError ? err.reason : 'other error';
  }
}

describe('decodeBolt11: BOLT11 test vectors', () => {
  it.each(spec.valid)('decodes "$title"', ({ invoice }) => {
    const decoded = decodeBolt11(invoice);
    expect(decoded.timestamp).toBeGreaterThan(1_496_000_000);
    expect(decoded.bolt11).toBe(invoice.toLowerCase());
  });

  it('reads payee, payment hash, amount and description of the donation and coffee vectors', () => {
    const donation = decodeBolt11(vector('Please make a donation'));
    expect(donation).toMatchObject({
      network: 'mainnet',
      payee: SPEC_PAYEE,
      paymentHash: SPEC_HASH,
      timestamp: 1496314658,
    });
    expect(donation.amount).toBeUndefined();
    expect(donation.description).toBe('Please consider supporting this project');
    expect(donation.expirySeconds).toBe(3600);
    expect(donation.minFinalCltvExpiryDelta).toBe(18);
    const coffee = decodeBolt11(vector('Please send $3 for a cup of coffee'));
    expect(coffee.amount).toBe(250_000_000n);
    expect(coffee.description).toBe('1 cup coffee');
    expect(coffee.expirySeconds).toBe(60);
    expect(decodeBolt11(vector('Please send 0.0025 BTC for a cup of nonsense')).description).toBe(
      '\u30ca\u30f3\u30bb\u30f3\u30b9 1\u676f',
    );
  });

  it('reads the description hash, the fallback addresses and the route hints', () => {
    const hashed = decodeBolt11(vector('Now send $24'));
    expect(hashed.description).toBeUndefined();
    expect(hashed.descriptionHash).toBe(CAKE_HASH);
    expect(decodeBolt11(vector('The same, on testnet')).fallbacks).toEqual([
      { address: 'mk2QpYatsKicvFVuTAQLBryyccRXMUaGHP', type: 'p2pkh' },
    ]);
    expect(decodeBolt11(vector('The same, on testnet')).network).toBe('testnet4');
    const fallbacks = (title: string) => decodeBolt11(vector(title)).fallbacks;
    expect(fallbacks('On mainnet, with fallback (P2SH)')).toEqual([
      { address: '3EktnHQD7RiAE6uzMj2ZifT9YgRrkSgzQX', type: 'p2sh' },
    ]);
    expect(fallbacks('On mainnet, with fallback (P2WPKH)')).toEqual([
      { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', type: 'p2wpkh' },
    ]);
    expect(fallbacks('On mainnet, with fallback (P2WSH)')).toEqual([
      { address: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', type: 'p2wsh' },
    ]);
    expect(fallbacks('On mainnet, with fallback (P2TR)')).toEqual([
      { address: 'bc1pptdvg0d2nj99568qn6ssdy4cygnwuxgw2ukmnwgwz7jpqjz2kszse2s3lm', type: 'p2tr' },
    ]);
    const routed = decodeBolt11(vector('On mainnet, with fallback address 1RustyRX2oai4EYYDpQGWvEL62BBGqN9T'));
    expect(routed.fallbacks).toEqual([{ address: '1RustyRX2oai4EYYDpQGWvEL62BBGqN9T', type: 'p2pkh' }]);
    expect(routed.routeHints).toEqual([
      [
        {
          pubkey: '029e03a901b85534ff1e92c43c74431f7ce72046060fcf7a95c37e148f78c77255',
          shortChannelId: '66051x263430x1800',
          feeBaseMsat: 1,
          feeProportionalMillionths: 20,
          cltvExpiryDelta: 3,
        },
        {
          pubkey: '039e03a901b85534ff1e92c43c74431f7ce72046060fcf7a95c37e148f78c77255',
          shortChannelId: '197637x395016x2314',
          feeBaseMsat: 2,
          feeProportionalMillionths: 30,
          cltvExpiryDelta: 4,
        },
      ],
    ]);
  });

  it('reads a pico amount, a week of expiry, a CLTV delta and the payee of another node', () => {
    const pico = decodeBolt11(vector('Please send 0.00967878534 BTC'));
    expect(pico.amount).toBe(967_878_534n);
    expect(pico.expirySeconds).toBe(604_800);
    expect(pico.minFinalCltvExpiryDelta).toBe(10);
    expect(pico.routeHints[0]?.[0]).toEqual({
      pubkey: '03d06758583bb5154774a6eb221b1276c9e82d65bbaceca806d90e20c108f4b1c7',
      shortChannelId: '589390x3312x1',
      feeBaseMsat: 1000,
      feeProportionalMillionths: 2500,
      cltvExpiryDelta: 40,
    });
  });

  it('reads feature bits, ignores the fields that must be ignored, and reads payment metadata', () => {
    const features = decodeBolt11(vector('Please send $30 for coffee beans'));
    expect(features.featureBits).toEqual([8, 14, 99]);
    expect(features.features).toBe('08000000000000000000004100');
    expect(decodeBolt11(vector('Same, but all upper case')).paymentHash).toBe(SPEC_HASH);
    const ignored = decodeBolt11(vector('Same, but including fields which must be ignored'));
    expect(ignored.paymentHash).toBe(SPEC_HASH);
    expect(ignored.payee).toBe(SPEC_PAYEE);
    expect(ignored.fallbacks).toEqual([]);
    expect(decodeBolt11(vector('Please send 0.01 BTC with payment metadata')).metadata).toBe('01fafaf0');
  });

  it('accepts a high-S signature without an n field (public-key recovery)', () => {
    // The vector keeps the recovery id of the low-S signature, so the recovered key is not the vectors' key. CLN's
    // `decode` gives the same payee (checked on regtest, 2026-10-13).
    expect(decodeBolt11(vector('Public-key recovery with high-S signature')).payee).toBe(
      '02d0139ce7427d6dfffd26a326c18be754ef1e64672b42694ba5b23ef6e6e7803d',
    );
  });

  it.each([
    ['Same, but adding invalid unknown feature 100', 'unknown_feature'],
    ['Bech32 checksum is invalid', 'malformed'],
    ['Malformed bech32 string (no 1)', 'malformed'],
    ['Malformed bech32 string (mixed case)', 'malformed'],
    ['Signature is not recoverable', 'invalid_signature'],
    ['String is too short', 'malformed'],
    ['Invalid multiplier', 'invalid_amount'],
    ['Invalid sub-millisatoshi precision', 'invalid_amount'],
    ['Missing required `s` field', 'missing_field'],
    ["Non canonical signature (high-S) with 'n' field defined", 'invalid_signature'],
  ])('refuses "%s" (%s)', (title, reason) => {
    expect(reasonOf(() => decodeBolt11(vector(title)))).toBe(reason);
  });

  it('covers every invalid vector of the specification', () => {
    expect(spec.invalid).toHaveLength(10);
  });
});

describe('decodeBolt11: invoices from the regtest nodes', () => {
  it.each(regtest.invoices)(
    '$chain $implementation invoice of $amountMsat msat reads as the node decodes it',
    (fixture) => {
      const decoded = decodeBolt11(fixture.bolt11);
      expect(decoded.network).toBe('regtest');
      expect(decoded.payee).toBe(fixture.payee);
      expect(decoded.paymentHash).toBe(fixture.paymentHash);
      expect(decoded.amount === undefined ? null : decoded.amount.toString()).toBe(fixture.amountMsat);
      expect(decoded.timestamp).toBe(fixture.timestamp);
      expect(decoded.expirySeconds).toBe(fixture.expiry);
      expect(decoded.minFinalCltvExpiryDelta).toBe(fixture.minFinalCltvExpiryDelta);
      expect(decoded.description ?? null).toBe(fixture.description);
      expect(decoded.descriptionHash ?? null).toBe(fixture.descriptionHash ?? null);
      if ('features' in fixture && typeof fixture.features === 'string')
        expect(decoded.features).toBe(fixture.features);
      if ('featureBits' in fixture && Array.isArray(fixture.featureBits)) {
        expect(decoded.featureBits).toEqual(fixture.featureBits);
      }
    },
  );

  it('decodes a description hash that is SHA-256 of the description', () => {
    const expected = bytesToHex(sha256(new TextEncoder().encode(regtest.descriptionHashed)));
    const hashed = regtest.invoices.filter((i) => i.descriptionHash);
    expect(hashed).toHaveLength(4);
    for (const fixture of hashed) expect(decodeBolt11(fixture.bolt11).descriptionHash).toBe(expected);
  });

  it.each(regtest.invoices)(
    '$chain $implementation invoice passes its own chain and is refused on the other',
    (fixture) => {
      const decoded = decodeBolt11(fixture.bolt11);
      const own = fixture.chain === 'blake2b' ? 'required' : 'refused';
      const other = fixture.chain === 'blake2b' ? 'refused' : 'required';
      expect(() => checkInvoiceChain(decoded, { network: 'regtest', invoiceBit512: own })).not.toThrow();
      expect(reasonOf(() => checkInvoiceChain(decoded, { network: 'regtest', invoiceBit512: other }))).toBe(
        'wrong_chain',
      );
      expect(reasonOf(() => checkInvoiceChain(decoded, { network: 'mainnet', invoiceBit512: own }))).toBe(
        'wrong_network',
      );
    },
  );
});

describe('decodeBolt11: field rules', () => {
  const decodeSigned = async (fields: number[][], hrp = 'lnbcrt10u', options = {}) =>
    decodeBolt11(await signInvoice(hrp, fields, options));
  const reasonSigned = async (fields: number[][], hrp = 'lnbcrt10u', options = {}) => {
    const invoice = await signInvoice(hrp, fields, options);
    return reasonOf(() => decodeBolt11(invoice));
  };

  it('recovers the signer, and verifies against an n field', async () => {
    const decoded = await decodeSigned(BASE_FIELDS());
    expect(decoded.payee).toBe(bytesToHex(TEST_PUBKEY));
    expect(decoded.paymentHash).toBe(bytesToHex(HASH));
    expect(decoded.amount).toBe(1_000_000n);
    const withN = await decodeSigned(BASE_FIELDS([bytesField(TAGS.n, TEST_PUBKEY)]));
    expect(withN.payee).toBe(bytesToHex(TEST_PUBKEY));
  });

  it('refuses a signature that does not match the n field, a bad recovery id and a high-S signature with n', async () => {
    const other = Uint8Array.of(5, ...new Uint8Array(32).fill(1)); // not a public key encoding
    expect(await reasonSigned(BASE_FIELDS([bytesField(TAGS.n, other)]))).toBe('malformed');
    const otherKey = Uint8Array.from(TEST_PUBKEY);
    otherKey[0] = otherKey[0] === 2 ? 3 : 2;
    expect(await reasonSigned(BASE_FIELDS([bytesField(TAGS.n, otherKey)]))).toBe('invalid_signature');
    expect(await reasonSigned(BASE_FIELDS(), 'lnbcrt10u', { recovery: 4 })).toBe('invalid_signature');
    expect(await reasonSigned(BASE_FIELDS([bytesField(TAGS.n, TEST_PUBKEY)]), 'lnbcrt10u', { highS: true })).toBe(
      'invalid_signature',
    );
    // Without n, the same high-S signature (recovery id flipped) recovers the signer.
    expect((await decodeSigned(BASE_FIELDS(), 'lnbcrt10u', { highS: true })).payee).toBe(bytesToHex(TEST_PUBKEY));
  });

  it('refuses an invoice whose signed data was changed', async () => {
    const invoice = await signInvoice('lnbcrt10u', BASE_FIELDS());
    const { prefix, words } = bech32.decode(invoice as `${string}1${string}`, false);
    // Change the amount: a valid checksum, but the signature now recovers another key or none; with n it fails.
    const moved = bech32.encode('lnbcrt20u', words, false);
    expect(decodeBolt11(moved).payee).not.toBe(bytesToHex(TEST_PUBKEY));
    expect(prefix).toBe('lnbcrt10u');
    const withN = await signInvoice('lnbcrt10u', BASE_FIELDS([bytesField(TAGS.n, TEST_PUBKEY)]));
    const tampered = bech32.encode('lnbcrt20u', bech32.decode(withN as `${string}1${string}`, false).words, false);
    expect(reasonOf(() => decodeBolt11(tampered))).toBe('invalid_signature');
  });

  it('requires a payment hash, a payment secret and exactly one of description and description hash', async () => {
    const [p, s, d, f] = BASE_FIELDS();
    if (!p || !s || !d || !f) throw new Error('fields');
    expect(await reasonSigned([s, d, f])).toBe('missing_field');
    expect(await reasonSigned([p, d, f])).toBe('missing_field');
    expect(await reasonSigned([p, s, f])).toBe('missing_field');
    expect(await reasonSigned([p, s, d, f, bytesField(TAGS.h, HASH)])).toBe('malformed');
    const hashed = await decodeSigned([p, s, f, bytesField(TAGS.h, HASH)]);
    expect(hashed.descriptionHash).toBe(bytesToHex(HASH));
  });

  it('skips fixed-length fields of the wrong length and uses the first of repeated fields', async () => {
    const short = field(TAGS.p, new Array<number>(51).fill(3));
    const decoded = await decodeSigned([
      short,
      ...BASE_FIELDS(),
      bytesField(TAGS.p, SECRET),
      textField(TAGS.d, 'second'),
    ]);
    expect(decoded.paymentHash).toBe(bytesToHex(HASH));
    expect(decoded.description).toBe('test');
  });

  it('refuses padding bits in a hash, invalid UTF-8 and malformed routing hints', async () => {
    const [, s, d, f] = BASE_FIELDS();
    if (!s || !d || !f) throw new Error('fields');
    expect(await reasonSigned([field(TAGS.p, [...new Array<number>(51).fill(0), 1]), s, d, f])).toBe('malformed');
    const [p] = BASE_FIELDS();
    if (!p) throw new Error('fields');
    expect(await reasonSigned([p, s, bytesField(TAGS.d, Uint8Array.of(0xff, 0xfe)), f])).toBe('malformed');
    expect(await reasonSigned(BASE_FIELDS([bytesField(TAGS.r, new Uint8Array(50))]))).toBe('malformed');
  });

  it('strips bidirectional controls from the description', async () => {
    const [p, s, , f] = BASE_FIELDS();
    if (!p || !s || !f) throw new Error('fields');
    const rlo = String.fromCharCode(0x202e);
    const decoded = await decodeSigned([p, s, textField(TAGS.d, `pay ${rlo}evil`), f]);
    expect(decoded.description).toBe('pay evil');
  });

  it('refuses unknown even feature bits and a feature without its dependency, ignores unknown odd bits', async () => {
    expect(await reasonSigned(BASE_FIELDS([], [8, 14, 17, 100]))).toBe('unknown_feature');
    expect(await reasonSigned(BASE_FIELDS([], [8, 17]))).toBe('unknown_feature');
    expect((await decodeSigned(BASE_FIELDS([], [8, 14, 17, 101]))).featureBits).toEqual([8, 14, 17, 101]);
    const blake2b = await decodeSigned(BASE_FIELDS([], [8, 14, 17, 25, 512]));
    expect(blake2b.featureBits).toEqual([8, 14, 17, 25, 512]);
    expect(blake2b.features.length).toBe(130);
    expect((await decodeSigned(BASE_FIELDS([], []))).features).toBe('');
  });

  it('refuses expiry, final CLTV delta and features written with leading zero words', async () => {
    expect(await reasonSigned(BASE_FIELDS([field(TAGS.x, [0, 1, 28])]))).toBe('not_minimal');
    expect(await reasonSigned(BASE_FIELDS([field(TAGS.c, [0, 9])]))).toBe('not_minimal');
    const [p, s, d] = BASE_FIELDS();
    if (!p || !s || !d) throw new Error('fields');
    expect(await reasonSigned([p, s, d, field(TAGS['9'], [0, ...featureWords([8, 14])])])).toBe('not_minimal');
  });

  it('reads expiry and CLTV delta, refuses values that cannot make a valid date', async () => {
    const decoded = await decodeSigned(
      BASE_FIELDS([field(TAGS.x, numberWords(7200n)), field(TAGS.c, numberWords(144n))]),
    );
    expect(decoded.expirySeconds).toBe(7200);
    expect(decoded.expiresAt.getTime()).toBe((1_700_000_000 + 7200) * 1000);
    expect(decoded.minFinalCltvExpiryDelta).toBe(144);
    expect(await reasonSigned(BASE_FIELDS([field(TAGS.x, numberWords(2n ** 31n))]))).toBe('malformed');
    expect(await reasonSigned(BASE_FIELDS([field(TAGS.x, new Array<number>(8).fill(31))]))).toBe('malformed');
    expect(await reasonSigned(BASE_FIELDS([field(TAGS.c, numberWords(2n ** 32n))]))).toBe('malformed');
    expect(await reasonSigned(BASE_FIELDS([field(TAGS.c, new Array<number>(8).fill(31))]))).toBe('malformed');
  });

  it('uses the first of repeated expiry, CLTV delta and metadata fields', async () => {
    const decoded = await decodeSigned(
      BASE_FIELDS([
        field(TAGS.x, numberWords(60n)),
        field(TAGS.x, numberWords(120n)),
        field(TAGS.c, numberWords(40n)),
        field(TAGS.c, numberWords(80n)),
        bytesField(TAGS.m, Uint8Array.of(1)),
        bytesField(TAGS.m, Uint8Array.of(2)),
      ]),
    );
    expect(decoded).toMatchObject({ expirySeconds: 60, minFinalCltvExpiryDelta: 40, metadata: '01' });
  });

  it('skips fallbacks of unknown versions or invalid programs', async () => {
    const decoded = await decodeSigned(
      BASE_FIELDS([
        field(TAGS.f, [19, ...new Array<number>(32).fill(0)]),
        field(TAGS.f, [17, 0, 0]),
        field(TAGS.f, [0, 0, 0, 0, 0]),
        field(TAGS.f, []),
        field(TAGS.f, [2, 0, 0, 0, 0]),
      ]),
    );
    expect(decoded.fallbacks).toEqual([{ address: 'bcrt1zqqqq0u8uvu', type: 'witness-unknown' }]);
  });

  it('refuses unknown currencies, a non-Lightning prefix, truncated fields and bad amounts', async () => {
    expect(await reasonSigned(BASE_FIELDS(), 'lnxyz10u')).toBe('unknown_prefix');
    expect(await reasonSigned(BASE_FIELDS(), 'bcrt10u')).toBe('malformed');
    expect(await reasonSigned([...BASE_FIELDS(), [TAGS.d, 0]])).toBe('malformed');
    expect(await reasonSigned([...BASE_FIELDS(), [TAGS.d, 0, 20, 1]])).toBe('malformed');
    expect(await reasonSigned(BASE_FIELDS(), 'lnbcrt21000001')).toBe('invalid_amount');
    expect(await reasonSigned(BASE_FIELDS(), 'lnbcrt015u')).toBe('invalid_amount');
  });

  it('accepts the lightning: scheme in any case and refuses mixed-case invoices', async () => {
    const invoice = await signInvoice('lnbcrt10u', BASE_FIELDS());
    expect(decodeBolt11(`LIGHTNING:${invoice.toUpperCase()}`).bolt11).toBe(invoice);
    expect(decodeBolt11(`Lightning:${invoice}`).bolt11).toBe(invoice);
    expect(reasonOf(() => decodeBolt11(invoice.slice(0, 20) + invoice.slice(20).toUpperCase()))).toBe('malformed');
  });

  it('reads the payee for every network prefix', async () => {
    expect((await decodeSigned(BASE_FIELDS(), 'lnbc10u')).network).toBe('mainnet');
    expect((await decodeSigned(BASE_FIELDS(), 'lntb10u')).network).toBe('testnet4');
    expect((await decodeSigned(BASE_FIELDS(), 'lntbs10u')).network).toBe('signet');
  });
});

describe('checkInvoiceChain', () => {
  const sign = (features: number[]) => signInvoice('lnbcrt10u', BASE_FIELDS([], features)).then(decodeBolt11);

  it('requires bit 512 or 513 on the BLAKE2b profile and refuses both on the Bitcoin profile', async () => {
    const blake2b = { network: 'regtest', invoiceBit512: 'required' } as const;
    const bitcoin = { network: 'regtest', invoiceBit512: 'refused' } as const;
    for (const features of [
      [8, 14, 17, 512],
      [8, 14, 17, 513],
    ]) {
      const invoice = await sign(features);
      expect(() => checkInvoiceChain(invoice, blake2b)).not.toThrow();
      expect(reasonOf(() => checkInvoiceChain(invoice, bitcoin))).toBe('wrong_chain');
    }
    const stock = await sign([8, 14, 17]);
    expect(() => checkInvoiceChain(stock, bitcoin)).not.toThrow();
    expect(reasonOf(() => checkInvoiceChain(stock, blake2b))).toBe('wrong_chain');
  });

  it('names both chains and networks in its messages', async () => {
    const stock = await sign([8, 14, 17]);
    expect(() => checkInvoiceChain(stock, { network: 'regtest', invoiceBit512: 'required' })).toThrow(
      /Bitcoin BLAKE2b/,
    );
    expect(() => checkInvoiceChain(stock, { network: 'mainnet', invoiceBit512: 'refused' })).toThrow(
      /regtest.*mainnet/,
    );
  });
});

describe('decodeFailure', () => {
  it('maps a refusal to validation_failed with the reason in details', () => {
    const error = decodeFailure(new DecodeError('wrong_chain', 'This invoice is for Bitcoin BLAKE2b.'));
    expect(error.code).toBe('validation_failed');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ reason: 'wrong_chain' });
    expect(error.message).toBe('This invoice is for Bitcoin BLAKE2b.');
  });
});
