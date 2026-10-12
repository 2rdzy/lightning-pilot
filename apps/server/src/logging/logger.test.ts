import { describe, expect, it } from 'vitest';
import { parsePaymentHash, parsePubkey, parseTxid, type Txid } from '@lightning-pilot/core';
import { createLogger } from './logger.ts';
import { nodeDetail, REDACTED, redactString } from './redact.ts';

function capture(level: 'info' | 'debug' = 'info') {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ level, sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }, 'test');
  return { lines, logger };
}

const hex64 = 'ab'.repeat(32);
const rune = 'u3ho3QUnwNbrwyn6pITK4bv2Q3W-V9JeAaTV9rMDTj09MCZpZCEmbWV0aG9kPWdldGluZm8';

describe('logger', () => {
  it('writes one JSON object per line with time, level, module, msg and requestId', () => {
    const { lines, logger } = capture();
    logger.info('node added', { requestId: 'r-1', chain: 'blake2b' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      module: 'test',
      msg: 'node added',
      requestId: 'r-1',
      chain: 'blake2b',
    });
    expect(Date.parse(String(lines[0]?.time))).not.toBeNaN();
  });

  it('drops lines below the level, per module', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', modules: { chatty: 'debug' }, sink: (l) => lines.push(l) });
    logger.info('hidden');
    logger.child('chatty').debug('shown');
    expect(lines).toHaveLength(1);
  });

  it('redacts denied field names at any depth', () => {
    const { lines, logger } = capture();
    logger.info('x', {
      password: 'hunter2',
      nested: { viewRune: 'abc', sessionToken: 't', deep: [{ preimage: 'p', Authorization: 'a', cookie: 'c' }] },
      keyId: '0123456789abcdef',
      idempotencyKey: 'k',
    });
    const line = JSON.stringify(lines[0]);
    for (const secret of ['hunter2', '"abc"', '"t"', '"p"', '"a"', '"c"', '"k"']) expect(line).not.toContain(secret);
    expect(lines[0]?.keyId).toBe('0123456789abcdef');
  });

  it('keeps typed identifiers only when they have their shape', () => {
    const { lines, logger } = capture();
    logger.info('x', {
      paymentHash: parsePaymentHash(hex64),
      pubkey: parsePubkey('02' + hex64),
      txid: parseTxid(hex64),
    });
    logger.info('y', { txid: 'not-a-txid' as Txid, pubkey: hex64 as never });
    expect(lines[0]).toMatchObject({ paymentHash: hex64, txid: hex64, pubkey: '02' + hex64 });
    expect(lines[1]).toMatchObject({ txid: REDACTED, pubkey: REDACTED });
  });

  it('scans string values for secret shapes in any other field', () => {
    const samples = [
      `rune ${rune} here`,
      `preimage ${hex64}`,
      'pay lnbcrt10n1p4v6pa9sp5m08939vx3laehags3dtga80af34n7f6ugke06lqj5xrvy7vugmzqpp5x',
      'Bearer abc.def',
      'tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK',
      'cHNidP8BAHECAAAAAQ',
      'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
      '123456789:AAEhBP0av28gSJ7C1UvWcSyfXKkDsZM_xyz',
    ];
    for (const sample of samples) expect(redactString(sample), sample).toContain(REDACTED);
    const { lines, logger } = capture();
    logger.info('x', { note: `with ${rune}`, err: new Error(`failed for ${hex64}`) });
    expect(JSON.stringify(lines[0])).not.toContain(rune);
    expect(JSON.stringify(lines[0])).not.toContain(hex64);
  });

  it('cuts node error text to 500 characters after redaction', () => {
    expect(nodeDetail('no route. '.repeat(200))?.length).toBe(500);
    expect(nodeDetail(`bad ${hex64}`)).toBe(`bad ${REDACTED}`);
  });

  it('prints the setup token on its own line to stdout only', () => {
    const lines: string[] = [];
    const out: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), stdout: (l) => out.push(l) });
    logger.setupToken('ABCD-EFGH', 'https://localhost:8443/setup');
    expect(lines).toEqual([]);
    expect(JSON.parse(out[0] ?? '{}')).toMatchObject({
      setupToken: 'ABCD-EFGH',
      setupUrl: 'https://localhost:8443/setup',
    });
  });
});
