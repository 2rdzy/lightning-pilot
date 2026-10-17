// Pure helpers of the settings screens: the spending-limits form, session timeouts in readable units, the node form
// and the search params of the unresolved-spends list. Kept out of the components so they are tested in Node.
import {
  ManageNodeRequest,
  NodeSummary,
  SessionPolicy,
  SpendPolicy,
  type Chain,
  type Network,
} from '@lightning-pilot/core';
import { z } from 'zod';
import { ApiError } from '../../api/client.ts';
import { formatCoins, formatInteger } from '../../i18n/format.ts';

export type NodeRow = z.infer<typeof NodeSummary>;
export type SessionTimeouts = z.infer<typeof SessionPolicy>;

// --- Spending limits (spend policy §2) ---

export type FeeMode = 'refuse' | 'step-up';

// The form keeps every field as typed text; empty cap fields mean "no limit".
export interface PolicyForm {
  maxPerPayment: string;
  max24h: string;
  stepUpAbove: string;
  maxFeeRate: string;
  maxFeeSharePercent: string;
  maxRoutingFeeSharePercent: string;
  routingFeeAllowance: string;
  maxFeeRateMode: FeeMode;
  maxFeeShareMode: FeeMode;
  maxRoutingFeeMode: FeeMode;
}

// The starting values when a node has no policy yet: no caps, and the fee caps of the node-management example
// (node-management §2). The owner sees and confirms them before anything is saved.
export const DEFAULT_POLICY_FORM: PolicyForm = {
  maxPerPayment: '',
  max24h: '',
  stepUpAbove: '',
  maxFeeRate: '10',
  maxFeeSharePercent: '5',
  maxRoutingFeeSharePercent: '1',
  routingFeeAllowance: '10',
  maxFeeRateMode: 'refuse',
  maxFeeShareMode: 'refuse',
  maxRoutingFeeMode: 'refuse',
};

export function policyToForm(policy: SpendPolicy | null): PolicyForm {
  if (!policy) return { ...DEFAULT_POLICY_FORM };
  return {
    maxPerPayment: policy.maxPerPayment ?? '',
    max24h: policy.max24h ?? '',
    stepUpAbove: policy.stepUpAbove ?? '',
    maxFeeRate: policy.maxFeeRate,
    maxFeeSharePercent: String(policy.maxFeeSharePercent),
    maxRoutingFeeSharePercent: String(policy.maxRoutingFeeSharePercent),
    routingFeeAllowance: policy.routingFeeAllowance,
    maxFeeRateMode: policy.maxFeeRateMode,
    maxFeeShareMode: policy.maxFeeShareMode,
    maxRoutingFeeMode: policy.maxRoutingFeeMode,
  };
}

// Whole sats as typed: grouping spaces, dots and commas are not accepted, so "1.000" is never read as 1 or 1000.
const satsText = (value: string) => value.trim();
const percent = (value: string) => (/^[0-9]{1,3}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN);

export type PolicyResult = { ok: true; policy: SpendPolicy } | { ok: false; reason: 'order' | 'invalid' };

const WHOLE_SATS = /^(0|[1-9][0-9]{0,17})$/;

export function formToPolicy(form: PolicyForm): PolicyResult {
  const cap = (value: string) => (satsText(value) === '' ? null : satsText(value));
  // The order rule compares the caps as BigInt, and zod still runs it after a field has failed, so malformed amounts
  // are refused here first.
  const amounts = [form.maxPerPayment, form.max24h, form.stepUpAbove].map(cap);
  if (amounts.some((a) => a !== null && !WHOLE_SATS.test(a)) || !WHOLE_SATS.test(satsText(form.routingFeeAllowance)))
    return { ok: false, reason: 'invalid' };
  const parsed = SpendPolicy.safeParse({
    maxPerPayment: cap(form.maxPerPayment),
    max24h: cap(form.max24h),
    stepUpAbove: cap(form.stepUpAbove),
    maxFeeRate: form.maxFeeRate.trim(),
    maxFeeSharePercent: percent(form.maxFeeSharePercent),
    maxRoutingFeeSharePercent: percent(form.maxRoutingFeeSharePercent),
    routingFeeAllowance: satsText(form.routingFeeAllowance),
    maxFeeRateMode: form.maxFeeRateMode,
    maxFeeShareMode: form.maxFeeShareMode,
    maxRoutingFeeMode: form.maxRoutingFeeMode,
  });
  if (parsed.success) return { ok: true, policy: parsed.data };
  // The only refinement on the object is the order of the caps; every other issue is a field's own shape.
  const orderOnly = parsed.error.issues.every((issue) => issue.code === 'custom' && issue.path.length === 0);
  return { ok: false, reason: orderOnly ? 'order' : 'invalid' };
}

// --- Session timeouts (sessions §11: idle 60 s–7 days, absolute 60 s–365 days, idle ≤ absolute) ---

export const DURATION_UNITS = ['minutes', 'hours', 'days'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];
const UNIT_SECONDS: Record<DurationUnit, number> = { minutes: 60, hours: 3600, days: 86400 };

export interface Duration {
  value: string;
  unit: DurationUnit;
}

// The largest unit that shows the value exactly (3600 s is 1 hour, 5400 s is 90 minutes).
export function fromSeconds(seconds: number): Duration {
  for (const unit of ['days', 'hours'] as const)
    if (seconds % UNIT_SECONDS[unit] === 0) return { value: String(seconds / UNIT_SECONDS[unit]), unit };
  return { value: String(Math.round(seconds / 60)), unit: 'minutes' };
}

export function toSeconds(duration: Duration): number | undefined {
  if (!/^[0-9]{1,6}$/.test(duration.value.trim())) return undefined;
  return Number(duration.value.trim()) * UNIT_SECONDS[duration.unit];
}

export type SessionPolicyResult = { ok: true; policy: SessionTimeouts } | { ok: false; reason: 'order' | 'invalid' };

export function sessionPolicyOf(idle: Duration, absolute: Duration): SessionPolicyResult {
  const idleSeconds = toSeconds(idle),
    absoluteSeconds = toSeconds(absolute);
  if (idleSeconds === undefined || absoluteSeconds === undefined) return { ok: false, reason: 'invalid' };
  const parsed = SessionPolicy.safeParse({ idleSeconds, absoluteSeconds });
  if (parsed.success) return { ok: true, policy: parsed.data };
  const orderOnly = parsed.error.issues.every((issue) => issue.code === 'custom' && issue.path.length === 0);
  return { ok: false, reason: orderOnly ? 'order' : 'invalid' };
}

// --- Nodes (node-management §2) ---

export const ACCESS_LEVELS = ['read-only', 'standard', 'full', 'admin'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface NodeForm {
  name: string;
  chain: Chain;
  network: Network;
  url: string;
  caCertificate: string;
  serverName: string;
  // 'block': the JSON block printed by the setup command; 'runes': the two credentials pasted one by one.
  credentialForm: 'block' | 'runes';
  credentialBlock: string;
  viewRune: string;
  spendRune: string;
  accessLevel: AccessLevel;
  adminAcknowledged: boolean;
}

export const EMPTY_NODE_FORM: NodeForm = {
  name: '',
  chain: 'blake2b',
  network: 'mainnet',
  url: '',
  caCertificate: '',
  serverName: 'localhost',
  credentialForm: 'block',
  credentialBlock: '',
  viewRune: '',
  spendRune: '',
  accessLevel: 'standard',
  adminAcknowledged: false,
};

// The access level a pasted block names, so the form can ask for the admin acknowledgement before sending it. The
// server checks the block itself; this only reads it.
export function blockAccessLevel(block: string): AccessLevel | undefined {
  try {
    const value = JSON.parse(block) as unknown;
    if (typeof value !== 'object' || value === null || !('accessLevel' in value)) return undefined;
    const level = value.accessLevel;
    return ACCESS_LEVELS.find((l) => l === level);
  } catch {
    return undefined;
  }
}

export function chosenAccessLevel(form: NodeForm): AccessLevel | undefined {
  return form.credentialForm === 'block' ? blockAccessLevel(form.credentialBlock.trim()) : form.accessLevel;
}

export function needsAdminAcknowledgement(form: NodeForm): boolean {
  return chosenAccessLevel(form) === 'admin';
}

// The request body, or undefined when a field does not have the shape the server accepts. Either the block or the
// runes are sent, never both; with runes, a read-only level sends no spend credential.
export function nodeRequest(form: NodeForm, limits?: SpendPolicy): ManageNodeRequest | undefined {
  const credentials =
    form.credentialForm === 'block'
      ? { credentialBlock: form.credentialBlock.trim() }
      : {
          viewRune: form.viewRune.trim(),
          accessLevel: form.accessLevel,
          ...(form.accessLevel === 'read-only' ? {} : { spendRune: form.spendRune.trim() }),
        };
  const parsed = ManageNodeRequest.safeParse({
    name: form.name,
    chain: form.chain,
    network: form.network,
    implementation: 'cln',
    url: form.url.trim(),
    caCertificate: form.caCertificate.trim() + '\n',
    serverName: form.serverName.trim() || 'localhost',
    adminAcknowledged: needsAdminAcknowledgement(form) && form.adminAcknowledged,
    ...credentials,
    ...(limits ? { limits } : {}),
  });
  return parsed.success ? (parsed.data as ManageNodeRequest) : undefined;
}

// --- Error details the screens branch on ---

export function reasonOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const details = error.details as { reason?: unknown } | undefined;
  return typeof details?.reason === 'string' ? details.reason : undefined;
}

export function isStepUpRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'step_up_required';
}

export function needsLimits(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'setup_required' && reasonOf(error) === 'spend_policy_missing';
}

// --- Unresolved spends: `?node=` narrows the list to one node ---

export const SpendsSearch = z.object({ node: z.uuid().optional().catch(undefined) });
export type SpendsSearch = z.infer<typeof SpendsSearch>;

export function spendsSearch(search: Record<string, unknown>): SpendsSearch {
  const parsed = SpendsSearch.parse(search);
  return parsed.node === undefined ? {} : { node: parsed.node };
}

// --- Display: what a region's number format looks like (style guide §6a table) ---

export function regionSample(locale: string): { sats: string; coins: string } {
  return { sats: formatInteger(1_250_000n, locale), coins: formatCoins(1_250_000_000n, locale) };
}

// The region's name in English ("German (Switzerland)"), or the tag itself where the browser has no name for it.
export function regionName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}
