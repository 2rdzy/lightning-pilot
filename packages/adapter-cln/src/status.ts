// Node status: reachability, what each rune allows, the access level and the capabilities (credential scopes §1 and
// §4, domain and adapter §4). `checkrune` is called with the view rune and asks about a rune given as a parameter, so
// the spend rune is checked without ever being used.
import {
  AdapterError,
  capabilitiesAllowed,
  type Capability,
  type CredentialState,
  type AccessLevel,
  type NodeStatus,
} from '@lightning-pilot/core';
import { parse, type Call } from './context.ts';
import { METHOD_CLAUSES, METHODS, type ClnMethod } from './methods.ts';
import { CheckRune, GetInfo, PluginList } from './schemas.ts';
import { RUNE_REFUSED } from './client.ts';

// Methods outside our lists that tell the higher access levels apart (credential scopes §1): full management adds
// signmessage and stop; createrune is admin power.
const FULL_MANAGEMENT = ['signmessage', 'stop'];
const ADMIN = 'createrune';

export interface StatusContext {
  call: Call;
  viewRune: string;
  spendRune: string | undefined;
  lastSeen: { at?: string };
}

export async function getStatus(context: StatusContext): Promise<NodeStatus> {
  const { call, viewRune, spendRune, lastSeen } = context;
  try {
    parse(GetInfo, await call('getinfo', {}));
  } catch (err) {
    if (!(err instanceof AdapterError)) throw err;
    const reachable = err.code === 'node_credential_revoked';
    return {
      reachable,
      ...(lastSeen.at === undefined ? {} : { lastSeenAt: lastSeen.at }),
      credential: spendRune === undefined ? 'missing' : 'unknown',
      spendCredential: spendRune === undefined ? 'missing' : 'unknown',
      viewCredential: err.code === 'node_credential_revoked' ? 'revoked' : 'unknown',
      accessLevel: 'read-only',
      capabilities: [],
    };
  }
  lastSeen.at = new Date().toISOString();

  const allows = async (rune: string, method: string): Promise<boolean> => {
    const params = METHOD_CLAUSES[method as ClnMethod]?.params;
    try {
      return parse(CheckRune, await call('checkrune', { rune, method, ...(params ? { params } : {}) })).valid;
    } catch (err) {
      if (err instanceof AdapterError && [1501, RUNE_REFUSED, 1503].includes(err.nodeCode ?? 0)) return false;
      throw err;
    }
  };
  const methodsOf = (credential: 'read' | 'spend') => [
    ...new Set(METHODS.filter((r) => r.credential === credential).flatMap((r) => [...r.nodeMethods])),
  ];
  const check = async (rune: string | undefined, methods: string[]) =>
    new Map(await Promise.all(methods.map(async (m) => [m, rune !== undefined && (await allows(rune, m))] as const)));

  const [view, spend, extra] = await Promise.all([
    check(viewRune, methodsOf('read')),
    check(spendRune, methodsOf('spend')),
    check(spendRune, [...FULL_MANAGEMENT, ADMIN]),
  ]);
  const allowed = (row: (typeof METHODS)[number]) =>
    row.nodeMethods.every((m) => (row.credential === 'spend' ? spend.get(m) : view.get(m)) === true);

  const capabilities: Capability[] = capabilitiesAllowed(METHODS, (row) => allowed(row as (typeof METHODS)[number]));
  const transactions = METHODS.find((r) => r.port === 'onchain' && r.method === 'listTransactions');
  if (view.get('plugin') && transactions && allowed(transactions) && (await bookkeeperActive(call))) {
    capabilities.push('accounting.bookkeeper');
  }

  const spendAllowed = [...spend.values()].some(Boolean);
  const credential: CredentialState = spendRune === undefined ? 'missing' : spendAllowed ? 'ok' : 'revoked';
  let accessLevel: AccessLevel = 'read-only';
  if (credential === 'ok') {
    if (extra.get(ADMIN)) accessLevel = 'admin';
    else if (FULL_MANAGEMENT.every((m) => extra.get(m))) accessLevel = 'full';
    else accessLevel = 'standard';
  }
  return {
    reachable: true,
    lastSeenAt: lastSeen.at,
    credential,
    viewCredential: 'ok',
    spendCredential: credential,
    accessLevel,
    capabilities,
  };
}

async function bookkeeperActive(call: Call): Promise<boolean> {
  const { plugins } = parse(PluginList, await call('plugin', { subcommand: 'list' }));
  return plugins.some((p) => p.active && /(^|\/)bookkeeper$/.test(p.name));
}
