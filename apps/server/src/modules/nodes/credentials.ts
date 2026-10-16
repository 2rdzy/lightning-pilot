import { AppError, nodeMethodsFor, type NodeAdapter, type AccessLevel } from '@lightning-pilot/core';
import { METHODS, runeRestrictions } from '@lightning-pilot/adapter-cln';

export const FULL_METHODS = ['setconfig', 'signmessage', 'stop'];
const CONFIG = ['method/setconfig', 'pnameconfig=alias', 'pnameconfig=rgb', 'pnameconfig=autoclean-cycle'];
const PLUGIN = ['method/plugin', 'pnamesubcommand=list'];
export const ADMIN_WARNING =
  'An admin credential can reveal secrets, create credentials and bypass Lightning Pilot limits if the app is compromised.';

function refuse(permission: string): never {
  throw new AppError('permission_denied', 'The credential scope is not permitted.', { permission });
}
export interface RuneScope {
  id: string;
  methods: string[];
  admin: boolean;
  config?: string[];
}
// This is deliberately a small accepted grammar, not an interpreter for arbitrary rune expressions. Escaped,
// prefix, parameter-count and unknown restrictions fail closed; the node still verifies the opaque MAC.
export function inspectRune(rune: string, kind: 'read' | 'spend', level: AccessLevel): RuneScope {
  if (rune.length > 4096 || !/^[A-Za-z0-9_-]+={0,2}$/.test(rune)) refuse('encoding');
  const bytes = Buffer.from(rune, 'base64url');
  if (bytes.length <= 32 || bytes.toString('base64url') !== rune.replace(/=+$/, '')) refuse('encoding');
  const tail = bytes.subarray(32);
  if (tail.some((b) => b < 32 || b > 126 || b === 92)) refuse('restriction encoding');
  const clauses = tail
    .toString('ascii')
    .split('&')
    .map((c) => c.split('|'));
  const unique = clauses.shift();
  if (unique?.length !== 1 || !/^=[0-9]+(?:-[0-9]+)?$/.test(unique[0] ?? '')) refuse('rune id');
  const id = (unique[0] as string).slice(1);
  if (clauses.length === 0) {
    if (kind === 'spend' && level === 'admin') return { id, methods: [], admin: true };
    refuse('unrestricted');
  }
  const configClause = (clause: string[]) =>
    clause.length >= 2 &&
    new Set(clause).size === clause.length &&
    clause.includes('method/setconfig') &&
    clause.every((alternative) => CONFIG.includes(alternative));
  const equal = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
  if (!clauses.some((c) => equal(c, ['id!']))) refuse('id!');
  const methodClauses = clauses.filter((c) => c.every((a) => /^method=[a-z0-9-]+$/.test(a)));
  if (methodClauses.length !== 1) refuse('method');
  const methods = (methodClauses[0] as string[]).map((a) => a.slice(7));
  if (new Set(methods).size !== methods.length) refuse('duplicate method');
  const allowed = new Set<string>(nodeMethodsFor(METHODS, kind));
  if (kind === 'spend' && level === 'full') FULL_METHODS.forEach((m) => allowed.add(m));
  for (const m of methods) if (!allowed.has(m)) refuse(m);
  for (const c of clauses) {
    if (equal(c, ['id!']) || c === methodClauses[0]) continue;
    if (kind === 'read' && methods.includes('plugin') && equal(c, PLUGIN)) continue;
    if (kind === 'spend' && level === 'full' && methods.includes('setconfig') && configClause(c)) continue;
    refuse(c.join('|'));
  }
  if (methods.includes('plugin') && !clauses.some((c) => equal(c, PLUGIN))) refuse('plugin');
  if (methods.includes('setconfig') && !clauses.some((c) => configClause(c))) refuse('setconfig');
  // Without these reads we cannot establish or recheck chain identity and credential admission.
  if (kind === 'read')
    for (const m of ['getinfo', 'getrawblockbyheight', 'checkrune']) if (!methods.includes(m)) refuse(m);
  const config = clauses
    .find(configClause)
    ?.filter((a) => a.startsWith('pnameconfig='))
    .map((a) => a.slice(12));
  return { id, methods, admin: false, ...(config ? { config } : {}) };
}
export async function verifyRunes(adapter: NodeAdapter, view: string, spend: string | undefined, level: AccessLevel) {
  const read = inspectRune(view, 'read', level);
  const spending = spend === undefined ? undefined : inspectRune(spend, 'spend', level);
  if ((level === 'read-only') !== (spend === undefined)) refuse('access level');
  const probe = async (rune: string, method: string, expected: boolean) => {
    const params =
      method === 'plugin'
        ? { subcommand: 'list' }
        : method === 'setconfig'
          ? { config: spending?.config?.[0] ?? 'alias' }
          : undefined;
    const valid = await adapter.node.checkRune(rune, method, params);
    if (expected && !valid)
      throw new AppError('node_credential_revoked', 'The credential did not pass verification.', {
        method,
        credential: rune === view ? 'read' : 'spend',
      });
    if (!expected && valid) refuse(method);
  };
  for (const m of read.methods) await probe(view, m, true);
  for (const m of [...nodeMethodsFor(METHODS, 'spend'), ...FULL_METHODS, 'createrune', 'listdatastore', 'exposesecret'])
    await probe(view, m, false);
  if (spending && spend) {
    for (const m of spending.admin ? ['xpay', 'createrune'] : spending.methods) await probe(spend, m, true);
    if (!spending.admin)
      for (const m of [
        ...nodeMethodsFor(METHODS, 'read'),
        ...FULL_METHODS,
        'createrune',
        'listdatastore',
        'exposesecret',
      ]) {
        if (!spending.methods.includes(m)) await probe(spend, m, false);
      }
  }
  return { read, spend: spending };
}
export function setupCommand(level: Exclude<AccessLevel, 'admin'>): string {
  const view = runeRestrictions('read');
  const spend: string[][] = JSON.parse(runeRestrictions('spend')) as string[][];
  if (level === 'full') {
    spend[1]?.push(...FULL_METHODS.map((m) => `method=${m}`));
    spend.push(CONFIG);
  }
  // jq is explicit in the instructions: only local lightning-cli output is consumed, no downloaded script.
  return [
    `lp_node_view_rune=$(lightning-cli createrune restrictions='${view}' | jq -er .rune) &&`,
    ...(level === 'read-only'
      ? []
      : [`lp_node_spend_rune=$(lightning-cli createrune restrictions='${JSON.stringify(spend)}' | jq -er .rune) &&`]),
    `lp_node_block=$(jq -n --arg view "$lp_node_view_rune"${level === 'read-only' ? '' : ' --arg spend "$lp_node_spend_rune"'} '{version:1,implementation:"cln",accessLevel:"${level}",viewRune:$view${level === 'read-only' ? '' : ',spendRune:$spend'}}') &&`,
    `printf '%s\n' "$lp_node_block" &&`,
    `if command -v qrencode >/dev/null 2>&1; then printf '%s' "$lp_node_block" | qrencode -t UTF8 >&2; fi`,
    `unset lp_node_view_rune${level === 'read-only' ? '' : ' lp_node_spend_rune'} lp_node_block`,
  ].join('\n');
}
