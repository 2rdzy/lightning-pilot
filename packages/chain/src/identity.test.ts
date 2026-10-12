import { describe, expect, it } from 'vitest';
import type { Chain, Network } from '@lightning-pilot/core';
import fixtures from './fixtures/regtest-blocks.json' with { type: 'json' };
import { HeaderError, parseBlockHeader } from './header.ts';
import { checkChainIdentity, type IdentityInput } from './identity.ts';
import { BLAKE2B_ACTIVATION_HEIGHT, hasFeature } from './profile.ts';

const blake2b = fixtures.blake2b;
const sha256d = fixtures.sha256d;

function input(profile: Chain, chain: typeof blake2b, change: Partial<IdentityInput['facts']> = {}): IdentityInput {
  return {
    profile,
    network: 'regtest',
    facts: {
      network: 'regtest',
      networkRaw: 'regtest',
      features: chain.features,
      blockHeight: chain.height,
      synced: true,
      ...change,
    },
    tip: { height: chain.height, raw: chain.block },
    now: new Date('2026-10-12T00:00:00Z'),
  };
}

describe('parseBlockHeader', () => {
  it('reads a BLAKE2b block: 164-byte header, version top bit set', () => {
    expect(parseBlockHeader(blake2b.block)).toMatchObject({ versionTopBit: true, headerBytes: 164, txCount: 1n });
  });

  it('reads a Bitcoin block: 80-byte header, version top bit clear', () => {
    expect(parseBlockHeader(sha256d.block)).toMatchObject({ versionTopBit: false, headerBytes: 80, txCount: 1n });
  });

  it('refuses a block that does not parse in the format its version claims', () => {
    // A BLAKE2b version on an 80-byte header followed by a transaction: too short for 164 bytes.
    const forged = '000000a0' + sha256d.block.slice(8, 160 + 2);
    expect(() => parseBlockHeader(forged)).toThrow(HeaderError);
    // Header without a transaction count, zero transactions, non-canonical count, not hex.
    expect(() => parseBlockHeader(sha256d.block.slice(0, 160))).toThrow(HeaderError);
    expect(() => parseBlockHeader(sha256d.block.slice(0, 160) + '00')).toThrow(HeaderError);
    expect(() => parseBlockHeader(sha256d.block.slice(0, 160) + 'fd0100')).toThrow(HeaderError);
    expect(() => parseBlockHeader('zz')).toThrow(HeaderError);
  });
});

describe('hasFeature', () => {
  it('finds bit 512 in the CLN fork features and not in stock CLN', () => {
    expect(hasFeature(blake2b.features, 512) || hasFeature(blake2b.features, 513)).toBe(true);
    expect(hasFeature(sha256d.features, 512) || hasFeature(sha256d.features, 513)).toBe(false);
  });

  it('reads bits on the hex string, beyond 32 bits', () => {
    expect(hasFeature('0100' + '00'.repeat(63), 512)).toBe(true);
    expect(hasFeature('01', 0)).toBe(true);
    expect(hasFeature('01', 9)).toBe(false);
    expect(() => hasFeature('xyz', 1)).toThrow();
  });
});

describe('checkChainIdentity', () => {
  it('confirms each chain under its own profile', () => {
    expect(checkChainIdentity(input('blake2b', blake2b))).toMatchObject({ state: 'confirmed', profile: 'blake2b' });
    expect(checkChainIdentity(input('bitcoin', sha256d))).toMatchObject({ state: 'confirmed', profile: 'bitcoin' });
  });

  it('refuses a stock node under the BLAKE2b profile, and a BLAKE2b node under the Bitcoin profile (software)', () => {
    expect(checkChainIdentity(input('blake2b', sha256d))).toMatchObject({ state: 'refused', failedCheck: 'software' });
    expect(checkChainIdentity(input('bitcoin', blake2b))).toMatchObject({ state: 'refused', failedCheck: 'software' });
  });

  it('refuses BLAKE2b-aware software whose backend follows the SHA256d chain (header)', () => {
    const wrongBackend = { ...input('blake2b', blake2b), tip: { height: sha256d.height, raw: sha256d.block } };
    expect(checkChainIdentity(wrongBackend)).toMatchObject({ state: 'refused', failedCheck: 'header' });
    const unreadable = { ...input('bitcoin', sha256d), tip: { height: 1, raw: 'not hex' } };
    expect(checkChainIdentity(unreadable)).toMatchObject({ state: 'refused', failedCheck: 'header' });
  });

  it('refuses a wrong network and a network the profile does not have', () => {
    const wrong = input('blake2b', blake2b, { network: 'mainnet', networkRaw: 'bitcoin' });
    expect(checkChainIdentity(wrong)).toMatchObject({ state: 'refused', failedCheck: 'network' });
    const signet = { ...input('blake2b', blake2b), network: 'signet' as Network };
    expect(checkChainIdentity(signet)).toMatchObject({ state: 'refused', failedCheck: 'network' });
    const unknown = input('bitcoin', sha256d, { network: 'unknown', networkRaw: 'liquid' });
    expect(checkChainIdentity(unknown)).toMatchObject({ state: 'refused', failedCheck: 'network' });
  });

  it('waits below the activation height under either profile', () => {
    const height = (BLAKE2B_ACTIVATION_HEIGHT.mainnet ?? 0) - 1;
    for (const [profile, chain] of [
      ['blake2b', blake2b],
      ['bitcoin', sha256d],
    ] as const) {
      const below = {
        ...input(profile, chain, { network: 'mainnet', networkRaw: 'bitcoin', blockHeight: height }),
        network: 'mainnet' as Network,
      };
      expect(checkChainIdentity(below)).toMatchObject({ state: 'waiting', failedCheck: 'fork_height' });
    }
  });

  it('skips the height check on signet but still checks the header', () => {
    const signet = (raw: string) => ({
      ...input('bitcoin', sha256d, { network: 'signet', networkRaw: 'signet', blockHeight: 0 }),
      network: 'signet' as Network,
      tip: { height: 0, raw },
    });
    expect(checkChainIdentity(signet(sha256d.block))).toMatchObject({ state: 'confirmed' });
    expect(checkChainIdentity(signet(blake2b.block))).toMatchObject({ state: 'refused', failedCheck: 'header' });
  });

  it('waits while the backend is not synced', () => {
    expect(checkChainIdentity(input('blake2b', blake2b, { synced: false }))).toMatchObject({
      state: 'waiting',
      failedCheck: 'sync',
    });
  });

  it('refuses unreadable feature bits', () => {
    expect(checkChainIdentity(input('blake2b', blake2b, { features: 'zz' }))).toMatchObject({
      state: 'refused',
      failedCheck: 'software',
    });
  });
});
