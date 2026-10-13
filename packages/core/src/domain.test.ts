import { describe, expect, it } from 'vitest';
import { ChainIdentityResponse } from './api.ts';
import { FAILED_CHECKS } from './domain.ts';

describe('chain identity contract', () => {
  it('names every failed check, including a node that answers with another key', () => {
    expect(FAILED_CHECKS).toEqual(['network', 'software', 'header', 'fork_height', 'sync', 'unreachable', 'node']);
    const refused = { state: 'refused', profile: 'blake2b', checkedAt: '2026-10-13T00:00:00Z', failedCheck: 'node' };
    expect(ChainIdentityResponse.parse(refused)).toEqual(refused);
    expect(() => ChainIdentityResponse.parse({ ...refused, failedCheck: 'other' })).toThrow();
  });
});
