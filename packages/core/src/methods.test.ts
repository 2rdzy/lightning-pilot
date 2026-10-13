import { describe, expect, it } from 'vitest';
import { IdError, parseShortChannelId } from './ids.ts';
import { capabilitiesAllowed, credentialOf, nodeMethodsFor, type MethodTable } from './methods.ts';

const TABLE = [
  { port: 'pay', method: 'getPayment', nodeMethods: ['listsendpays'], credential: 'read', feature: 'D11' },
  {
    port: 'pay',
    method: 'pay',
    nodeMethods: ['xpay'],
    credential: 'spend',
    feature: 'D1',
    capabilities: ['pay.bolt11', 'pay.mpp'],
  },
  {
    port: 'pay',
    method: 'previewRoute',
    nodeMethods: ['getroutes'],
    credential: 'read',
    feature: 'D12',
    capabilities: ['pay.route_preview', 'pay.bolt11'],
  },
] as const satisfies MethodTable;

describe('method table helpers', () => {
  it('lists the node methods of a credential, sorted and once each', () => {
    expect(nodeMethodsFor(TABLE, 'read')).toEqual(['getroutes', 'listsendpays']);
    expect(credentialOf(TABLE, 'xpay')).toBe('spend');
    expect(credentialOf(TABLE, 'withdraw')).toBeUndefined();
  });

  it('reports a capability only when every row that provides it is allowed', () => {
    expect(capabilitiesAllowed(TABLE, () => true).sort()).toEqual(['pay.bolt11', 'pay.mpp', 'pay.route_preview']);
    // Without the spend credential: route preview stays, paying goes (pay.bolt11 also needs xpay).
    expect(capabilitiesAllowed(TABLE, (row) => row.credential === 'read')).toEqual(['pay.route_preview']);
    expect(capabilitiesAllowed(TABLE, () => false)).toEqual([]);
  });
});

describe('short channel ids', () => {
  it('accepts block x transaction x output and nothing else', () => {
    expect(parseShortChannelId('103x1x0')).toBe('103x1x0');
    for (const bad of ['103x1', '103:1:0', 'x1x0', '123456789x1x0', '1x1x123456', ' 1x1x0']) {
      expect(() => parseShortChannelId(bad), bad).toThrow(IdError);
    }
  });
});
