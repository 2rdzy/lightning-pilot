// Rune restrictions generated from the method table, for `lightning-cli createrune restrictions=…`. The first
// restriction, ["id!"], only passes when the call carries no peer id: the rune works over clnrest and never over
// commando from a peer. The second lists the allowed methods (alternatives within one restriction are ORed); then
// one restriction per narrowed method (`plugin` for `plugin list` only).
import { nodeMethodsFor, type Credential, type MethodTable } from '@lightning-pilot/core';
import { METHOD_CLAUSES, METHODS, type ClnMethod } from './methods.ts';

export function runeRestrictions(credential: Exclude<Credential, 'full'>, table: MethodTable = METHODS): string {
  const nodeMethods = nodeMethodsFor(table, credential);
  const clauses = nodeMethods.flatMap((m) => {
    const narrowed = METHOD_CLAUSES[m as ClnMethod];
    return narrowed ? [narrowed.clause] : [];
  });
  return JSON.stringify([['id!'], nodeMethods.map((m) => `method=${m}`), ...clauses]);
}
