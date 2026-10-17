import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client.ts';
import {
  blockAccessLevel,
  DEFAULT_POLICY_FORM,
  EMPTY_NODE_FORM,
  formToPolicy,
  fromSeconds,
  isStepUpRequired,
  needsAdminAcknowledgement,
  needsLimits,
  nodeRequest,
  policyToForm,
  reasonOf,
  regionName,
  regionSample,
  sessionPolicyOf,
  spendsSearch,
  toSeconds,
  type NodeForm,
} from './data.ts';

const CA = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
const NODE: NodeForm = {
  ...EMPTY_NODE_FORM,
  name: 'dave',
  url: 'https://192.168.1.20:3010',
  caCertificate: CA,
  credentialBlock: JSON.stringify({
    version: 1,
    implementation: 'cln',
    accessLevel: 'standard',
    viewRune: 'v',
    spendRune: 's',
  }),
};

describe('spending limits form', () => {
  it('starts from the example fee caps and no amount caps when a node has no policy', () => {
    expect(policyToForm(null)).toEqual(DEFAULT_POLICY_FORM);
    const result = formToPolicy(DEFAULT_POLICY_FORM);
    expect(result).toEqual({
      ok: true,
      policy: {
        maxPerPayment: null,
        max24h: null,
        stepUpAbove: null,
        maxFeeRate: '10',
        maxFeeSharePercent: 5,
        maxRoutingFeeSharePercent: 1,
        routingFeeAllowance: '10',
        maxFeeRateMode: 'refuse',
        maxFeeShareMode: 'refuse',
        maxRoutingFeeMode: 'refuse',
      },
    });
  });

  it('round-trips a stored policy', () => {
    const result = formToPolicy({
      ...DEFAULT_POLICY_FORM,
      maxPerPayment: '50000',
      max24h: '200000',
      stepUpAbove: '10000',
      maxFeeRate: '12.5',
      maxFeeRateMode: 'step-up',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(policyToForm(result.policy)).toMatchObject({ maxPerPayment: '50000', maxFeeRate: '12.5' });
  });

  it('tells a wrong order from a malformed value', () => {
    expect(formToPolicy({ ...DEFAULT_POLICY_FORM, maxPerPayment: '300', max24h: '200' })).toEqual({
      ok: false,
      reason: 'order',
    });
    expect(formToPolicy({ ...DEFAULT_POLICY_FORM, stepUpAbove: '500', maxPerPayment: '100' })).toEqual({
      ok: false,
      reason: 'order',
    });
    // Grouping marks are refused rather than guessed: "1.000" is neither 1 nor 1000.
    expect(formToPolicy({ ...DEFAULT_POLICY_FORM, maxPerPayment: '1.000' })).toEqual({ ok: false, reason: 'invalid' });
    // With both caps set the order rule would compare them as BigInt: a malformed one must not reach it.
    expect(formToPolicy({ ...DEFAULT_POLICY_FORM, maxPerPayment: '300', max24h: '1.000' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(formToPolicy({ ...DEFAULT_POLICY_FORM, routingFeeAllowance: '' })).toEqual({ ok: false, reason: 'invalid' });
    expect(formToPolicy({ ...DEFAULT_POLICY_FORM, maxFeeSharePercent: '0' })).toEqual({ ok: false, reason: 'invalid' });
    expect(formToPolicy({ ...DEFAULT_POLICY_FORM, maxFeeSharePercent: '5.5' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(formToPolicy({ ...DEFAULT_POLICY_FORM, maxFeeRate: '0' })).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('session timeouts', () => {
  it('shows seconds in the largest exact unit', () => {
    expect(fromSeconds(3600)).toEqual({ value: '1', unit: 'hours' });
    expect(fromSeconds(604800)).toEqual({ value: '7', unit: 'days' });
    expect(fromSeconds(5400)).toEqual({ value: '90', unit: 'minutes' });
    expect(toSeconds({ value: '90', unit: 'minutes' })).toBe(5400);
    expect(toSeconds({ value: '1.5', unit: 'hours' })).toBeUndefined();
  });

  it('keeps the server ranges and the order', () => {
    expect(sessionPolicyOf({ value: '1', unit: 'hours' }, { value: '7', unit: 'days' })).toEqual({
      ok: true,
      policy: { idleSeconds: 3600, absoluteSeconds: 604800 },
    });
    expect(sessionPolicyOf({ value: '2', unit: 'days' }, { value: '1', unit: 'days' })).toEqual({
      ok: false,
      reason: 'order',
    });
    expect(sessionPolicyOf({ value: '8', unit: 'days' }, { value: '30', unit: 'days' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(sessionPolicyOf({ value: '', unit: 'days' }, { value: '30', unit: 'days' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('node form', () => {
  it('sends the pasted block and nothing else for the credentials', () => {
    const body = nodeRequest(NODE);
    expect(body).toMatchObject({ name: 'dave', credentialBlock: NODE.credentialBlock, adminAcknowledged: false });
    expect(body && 'viewRune' in body).toBe(false);
  });

  it('sends the runes with the chosen level, and no spend rune when read-only', () => {
    const runes = { ...NODE, credentialForm: 'runes' as const, viewRune: ' v ', spendRune: 's' };
    expect(nodeRequest(runes)).toMatchObject({ viewRune: 'v', spendRune: 's', accessLevel: 'standard' });
    const readOnly = nodeRequest({ ...runes, accessLevel: 'read-only' });
    expect(readOnly && 'spendRune' in readOnly).toBe(false);
  });

  it('adds limits when given and refuses malformed connections', () => {
    const limits = formToPolicy(DEFAULT_POLICY_FORM);
    if (!limits.ok) throw new Error('default limits');
    expect(nodeRequest(NODE, limits.policy)?.limits).toEqual(limits.policy);
    expect(nodeRequest({ ...NODE, url: 'http://192.168.1.20:3010' })).toBeUndefined();
    expect(nodeRequest({ ...NODE, caCertificate: 'not a certificate' })).toBeUndefined();
    expect(nodeRequest({ ...NODE, name: ' ' })).toBeUndefined();
  });

  it('reads the access level of a block to ask for the admin acknowledgement', () => {
    const admin = { ...NODE, credentialBlock: NODE.credentialBlock.replace('standard', 'admin') };
    expect(blockAccessLevel(admin.credentialBlock)).toBe('admin');
    expect(blockAccessLevel('{')).toBeUndefined();
    expect(blockAccessLevel('[]')).toBeUndefined();
    expect(needsAdminAcknowledgement(admin)).toBe(true);
    expect(needsAdminAcknowledgement(NODE)).toBe(false);
    expect(needsAdminAcknowledgement({ ...NODE, credentialForm: 'runes', accessLevel: 'admin' })).toBe(true);
    expect(nodeRequest({ ...admin, adminAcknowledged: true })?.adminAcknowledged).toBe(true);
  });
});

describe('error details', () => {
  it('finds the reasons the screens branch on', () => {
    const missing = new ApiError('setup_required', 'x', 403, 'r', { reason: 'spend_policy_missing' });
    expect(needsLimits(missing)).toBe(true);
    expect(needsLimits(new ApiError('setup_required', 'x', 403, 'r', { reason: 'restore_reconciliation' }))).toBe(
      false,
    );
    expect(reasonOf(new ApiError('validation_failed', 'x', 400, 'r', { reason: 'broadcast' }))).toBe('broadcast');
    expect(reasonOf(new Error('x'))).toBeUndefined();
    expect(reasonOf(new ApiError('validation_failed', 'x', 400))).toBeUndefined();
    expect(isStepUpRequired(new ApiError('step_up_required', 'x', 403))).toBe(true);
    expect(isStepUpRequired(new Error('step_up_required'))).toBe(false);
  });
});

describe('unresolved spends search', () => {
  it('keeps a node id and drops anything else', () => {
    const id = '7d3f4b4e-2a7f-4c1e-9d3a-1b2c3d4e5f60';
    expect(spendsSearch({ node: id })).toEqual({ node: id });
    expect(spendsSearch({ node: 'alice' })).toEqual({});
    expect(spendsSearch({})).toEqual({});
  });
});

describe('display region', () => {
  it('shows the separators of the region (style guide §6a)', () => {
    expect(regionSample('en-US')).toEqual({ sats: '1,250,000', coins: '0.01250000' });
    expect(regionSample('de-DE')).toEqual({ sats: '1.250.000', coins: '0,01250000' });
    expect(regionSample('de-CH').sats).toBe("1'250'000");
    expect(regionName('de-CH')).toBe('German (Switzerland)');
    expect(regionName('not a tag')).toBe('not a tag');
  });
});
