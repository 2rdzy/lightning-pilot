// Property tests for malformed input. No property-testing library is in the agreed dependencies, so the cases come
// from a seeded generator: a failure prints the seed and the input, and the same seed gives the same cases again.
import { describe, expect, it } from 'vitest';
import { bech32 } from '@scure/base';
import { DecodeError } from './errors.ts';
import { decodeBolt11 } from './invoice.ts';
import { decodeRequest } from './request.ts';
import spec from './fixtures/bolt11-spec-vectors.json' with { type: 'json' };
import regtest from './fixtures/regtest-requests.json' with { type: 'json' };
import { BASE_FIELDS, field, signInvoice } from './fixtures/sign.ts';

const SEED = 20261013;
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// xorshift32: small, deterministic, good enough to spread test cases.
function generator(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  return {
    int: (max: number) => next() % max,
    pick: <T>(items: readonly T[]): T => {
      const item = items[next() % items.length];
      if (item === undefined) throw new Error('empty list');
      return item;
    },
  };
}

// Runs fn and returns what it threw, if it was anything other than a DecodeError.
function unexpectedError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof DecodeError ? undefined : err;
  }
}

const VALID = [...spec.valid.map((v) => v.invoice.toLowerCase()), ...regtest.invoices.map((i) => i.bolt11)];
const CONTEXT = { network: 'regtest', invoiceBit512: 'required' } as const;

describe('decoders on malformed input (seeded properties)', () => {
  it('refuses every invoice with one character changed (bech32 detects any single substitution)', () => {
    const random = generator(SEED);
    for (let i = 0; i < 500; i++) {
      const invoice = random.pick(VALID);
      const at = random.int(invoice.length);
      const old = invoice[at] ?? '';
      const replacement = random.pick([...CHARSET].filter((c) => c !== old));
      const changed = invoice.slice(0, at) + replacement + invoice.slice(at + 1);
      expect(() => decodeBolt11(changed), `seed ${SEED} case ${i}: ${changed}`).toThrow(DecodeError);
    }
  });

  it('throws only DecodeError for truncated, extended and spliced invoices', () => {
    const random = generator(SEED + 1);
    for (let i = 0; i < 500; i++) {
      const a = random.pick(VALID);
      const b = random.pick(VALID);
      const input =
        [
          a.slice(0, random.int(a.length)),
          a + random.pick([...CHARSET]),
          a.slice(0, random.int(a.length)) + b.slice(random.int(b.length)),
        ][i % 3] ?? '';
      expect(
        unexpectedError(() => decodeBolt11(input)),
        `seed ${SEED + 1} case ${i}: ${input}`,
      ).toBeUndefined();
    }
  });

  it('throws only DecodeError for correctly checksummed invoices with random field soup', async () => {
    const random = generator(SEED + 2);
    for (let i = 0; i < 300; i++) {
      const extra = Array.from({ length: random.int(4) }, () =>
        field(
          random.int(32),
          Array.from({ length: random.int(70) }, () => random.int(32)),
        ),
      );
      const fields = BASE_FIELDS(
        extra,
        Array.from({ length: random.int(4) }, () => random.int(600)),
      );
      if (random.int(4) === 0) fields.splice(random.int(fields.length), 1);
      const invoice = await signInvoice(random.pick(['lnbcrt', 'lnbc1m', 'lntb20n', 'lnbcrt5p']), fields);
      expect(
        unexpectedError(() => decodeBolt11(invoice)),
        `seed ${SEED + 2} case ${i}: ${invoice}`,
      ).toBeUndefined();
    }
  });

  it('throws only DecodeError for any word sequence with a valid checksum', () => {
    const random = generator(SEED + 3);
    for (let i = 0; i < 500; i++) {
      const words = Array.from({ length: 100 + random.int(300) }, () => random.int(32));
      const invoice = bech32.encode(random.pick(['lnbcrt', 'lnbc', 'lnbc10u', 'lntbs']), words, false);
      expect(
        unexpectedError(() => decodeBolt11(invoice)),
        `seed ${SEED + 3} case ${i}: ${invoice}`,
      ).toBeUndefined();
    }
  });

  it('classifies random text without throwing anything but DecodeError', () => {
    const random = generator(SEED + 4);
    const parts = [
      'bitcoin:',
      'lightning:',
      'ln',
      'lno1',
      'lnurl1',
      'lnurlp://',
      'bc1',
      'bcrt1',
      'tb1',
      '1',
      '3',
      'm',
      '2',
      '@',
      ':',
      '?',
      '&',
      '=',
      '%',
      '%zz',
      '[',
      ']',
      '.',
      '+',
      ' ',
      'amount=',
      'lightning=',
      'req-',
      'label=',
      '02',
      '03',
      'ff',
      '0',
      'q',
      'p',
      'Z',
      '\u202e',
      '\u00e9',
      '\ud83d\ude00',
      'onion',
      'example.com',
      'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    ];
    for (let i = 0; i < 2000; i++) {
      const input = Array.from({ length: 1 + random.int(12) }, () => random.pick(parts)).join('');
      expect(
        unexpectedError(() => decodeRequest(input, CONTEXT)),
        `seed ${SEED + 4} case ${i}: ${input}`,
      ).toBeUndefined();
    }
  });
});
