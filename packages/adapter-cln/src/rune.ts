// Rune restrictions generated from the method table, for `lightning-cli createrune restrictions=…`. The first
// restriction, ["id!"], only passes when the call carries no peer id: the rune works over clnrest and never over
// commando from a peer. The second lists the allowed methods (alternatives within one restriction are ORed).
import { nodeMethodsFor, type Credential, type MethodTable } from '@lightning-pilot/core';
import { METHODS } from './methods.ts';

export function runeRestrictions(credential: Exclude<Credential, 'full'>, table: MethodTable = METHODS): string {
  const methods = nodeMethodsFor(table, credential).map((m) => `method=${m}`);
  return JSON.stringify([['id!'], methods]);
}
