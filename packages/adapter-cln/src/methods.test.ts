import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeMethodsFor } from '@lightning-pilot/core';
import { METHODS } from './methods.ts';
import { runeRestrictions } from './rune.ts';

// The credential lists the regtest environment creates (the published credential scopes), read from the script.
function scriptList(name: string): string[] {
  const script = readFileSync(new URL('../../../tools/regtest/regtest', import.meta.url), 'utf8');
  const line = script.split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not found in tools/regtest/regtest`);
  return [...line.matchAll(/method=([a-z0-9-]+)/g)].map((m) => m[1] ?? '');
}

describe('method table', () => {
  it('names every port method once, with a known credential', () => {
    const keys = METHODS.map((row) => `${row.port}.${row.method}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const row of METHODS) expect(['read', 'spend']).toContain(row.credential);
  });

  it('never sends a spending command with the view rune', () => {
    const read = nodeMethodsFor(METHODS, 'read');
    for (const spending of ['xpay', 'xkeysend', 'pay', 'keysend', 'txsend', 'fundchannel', 'close', 'withdraw']) {
      expect(read).not.toContain(spending);
    }
  });

  it('generates rune restrictions from the table', () => {
    expect(JSON.parse(runeRestrictions('spend'))).toEqual([['id!'], ['method=xpay']]);
    expect(JSON.parse(runeRestrictions('read'))).toEqual([
      ['id!'],
      nodeMethodsFor(METHODS, 'read').map((m) => `method=${m}`),
    ]);
  });

  it('fits inside the published view and spend credential lists', () => {
    const view = scriptList('CLN_VIEW');
    const spend = scriptList('CLN_SPEND_METHODS');
    for (const m of nodeMethodsFor(METHODS, 'read')) expect(view, m).toContain(m);
    for (const m of nodeMethodsFor(METHODS, 'spend')) expect(spend, m).toContain(m);
    for (const m of nodeMethodsFor(METHODS, 'spend')) expect(view, m).not.toContain(m);
  });
});
