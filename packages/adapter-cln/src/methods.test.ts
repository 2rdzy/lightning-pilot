import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeMethodsFor, PORTS } from '@lightning-pilot/core';
import { createClnAdapter } from './adapter.ts';
import { METHODS } from './methods.ts';
import { runeRestrictions } from './rune.ts';

// The credential lists the regtest environment creates (the published credential scopes), read from the script.
function scriptList(name: string): string[] {
  const script = readFileSync(new URL('../../../tools/regtest/regtest', import.meta.url), 'utf8');
  const line = script.split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not found in tools/regtest/regtest`);
  return [...line.matchAll(/"method=([a-z0-9-]+)"/g)].map((m) => m[1] ?? '');
}

// The published lists of credential scopes §2 (view list as changed on 2026-10-13: no waitanyinvoice, no
// listchannels). A change here is a spec change.
const VIEW = [
  'getinfo',
  'listfunds',
  'listpeers',
  'listpeerchannels',
  'listclosedchannels',
  'listnodes',
  'listforwards',
  'listinvoices',
  'listsendpays',
  'listpays',
  'listtransactions',
  'bkpr-listaccountevents',
  'listoffers',
  'listhtlcs',
  'feerates',
  'getrawblockbyheight',
  'getchaininfo',
  'decode',
  'getroutes',
  'fetchinvoice',
  'wait',
  'waitblockheight',
  'invoice',
  'listaddresses',
  'offer',
  'disableoffer',
  'newaddr',
  'checkrune',
  'plugin',
];
const SPEND = [
  'xpay',
  'xkeysend',
  'txprepare',
  'txsend',
  'txdiscard',
  'unreserveinputs',
  'fundchannel',
  'close',
  'connect',
  'disconnect',
  'setchannel',
];

describe('method table', () => {
  it('has exactly one row per port method of the adapter', () => {
    const adapter = createClnAdapter({ url: 'https://localhost:1', caCertificate: '', serverName: 'x', viewRune: 'V' });
    const implemented = PORTS.flatMap((port) =>
      Object.keys((adapter as unknown as Record<string, object>)[port] ?? {}).map((m) => `${port}.${m}`),
    ).sort();
    const rows = METHODS.map((row) => `${row.port}.${row.method}`);
    expect(new Set(rows).size).toBe(rows.length);
    expect([...rows].sort()).toEqual(implemented);
    for (const row of METHODS) expect(['read', 'spend']).toContain(row.credential);
  });

  it('never sends a spending command with the view rune', () => {
    const read = nodeMethodsFor(METHODS, 'read');
    for (const spending of [...SPEND, 'pay', 'keysend', 'withdraw', 'sendpay']) expect(read).not.toContain(spending);
  });

  it('needs exactly the published view and spend lists', () => {
    expect(nodeMethodsFor(METHODS, 'read')).toEqual([...VIEW].sort());
    expect(nodeMethodsFor(METHODS, 'spend')).toEqual([...SPEND].sort());
  });

  it('generates rune restrictions from the table, with plugin narrowed to plugin list', () => {
    expect(JSON.parse(runeRestrictions('spend'))).toEqual([['id!'], [...SPEND].sort().map((m) => `method=${m}`)]);
    expect(JSON.parse(runeRestrictions('read'))).toEqual([
      ['id!'],
      [...VIEW].sort().map((m) => `method=${m}`),
      ['method/plugin', 'pnamesubcommand=list'],
    ]);
  });

  it('matches the runes tools/regtest creates, both ways', () => {
    expect(scriptList('CLN_VIEW').sort()).toEqual(nodeMethodsFor(METHODS, 'read'));
    expect(scriptList('CLN_SPEND_METHODS').sort()).toEqual(nodeMethodsFor(METHODS, 'spend'));
    const script = readFileSync(new URL('../../../tools/regtest/regtest', import.meta.url), 'utf8');
    expect(script).toContain('["method/plugin","pnamesubcommand=list"]');
  });
});
