// Method-table format. Each adapter keeps one table (packages/adapter-<impl>/src/methods.ts) with one row per port
// method: the node methods it calls, the credential needed and the catalogue feature. The table is the single
// source for the credential lists (runes, macaroons) and for the test that the adapter calls nothing else.

export const CREDENTIALS = ['read', 'spend', 'full'] as const;
export type Credential = (typeof CREDENTIALS)[number];

export const PORTS = ['node', 'chain', 'balance', 'receive', 'pay'] as const;
export type PortName = (typeof PORTS)[number];

export interface MethodRow {
  port: PortName;
  method: string;
  nodeMethods: readonly string[];
  credential: Credential;
  feature: string;
}

export type MethodTable = readonly MethodRow[];

// The node methods a credential must allow, sorted and without duplicates.
export function nodeMethodsFor(table: MethodTable, credential: Credential): string[] {
  return [...new Set(table.filter((row) => row.credential === credential).flatMap((row) => row.nodeMethods))].sort();
}

// The credential a node method belongs to, or undefined if no port method calls it.
export function credentialOf(table: MethodTable, nodeMethod: string): Credential | undefined {
  return table.find((row) => row.nodeMethods.includes(nodeMethod))?.credential;
}
