// Method-table format. Each adapter keeps one table (packages/adapter-<impl>/src/methods.ts) with one row per port
// method: the node methods it calls, the credential needed and the catalogue feature. The table is the single
// source for the credential lists (runes, macaroons) and for the test that the adapter calls nothing else.

export const CREDENTIALS = ['read', 'spend', 'full'] as const;
export type Credential = (typeof CREDENTIALS)[number];

import type { Capability } from './domain.ts';

export const PORTS = [
  'node',
  'chain',
  'balance',
  'peer',
  'channel',
  'receive',
  'pay',
  'onchain',
  'routing',
  'events',
  'plugin',
] as const;
export type PortName = (typeof PORTS)[number];

export interface MethodRow {
  port: PortName;
  method: string;
  nodeMethods: readonly string[];
  credential: Credential;
  feature: string;
  // The capabilities this port method provides; a capability is reported when every row naming it is allowed by
  // the node's credentials (domain and adapter §4).
  capabilities?: readonly Capability[];
}

export type MethodTable = readonly MethodRow[];

// The node methods a credential must allow, sorted and without duplicates.
export function nodeMethodsFor(table: MethodTable, credential: Credential): string[] {
  return [...new Set(table.filter((row) => row.credential === credential).flatMap((row) => row.nodeMethods))].sort();
}

// The capabilities whose rows are all allowed, given the node methods each credential allows.
export function capabilitiesAllowed(table: MethodTable, allowed: (row: MethodRow) => boolean): Capability[] {
  const verdict = new Map<Capability, boolean>();
  for (const row of table) {
    for (const capability of row.capabilities ?? []) {
      verdict.set(capability, (verdict.get(capability) ?? true) && allowed(row));
    }
  }
  return [...verdict].filter(([, ok]) => ok).map(([capability]) => capability);
}

// The credential a node method belongs to, or undefined if no port method calls it.
export function credentialOf(table: MethodTable, nodeMethod: string): Credential | undefined {
  return table.find((row) => row.nodeMethods.includes(nodeMethod))?.credential;
}
