import { describe, expect, it } from 'vitest';
import type { Chain, Network } from '@lightning-pilot/core';
import fixtures from './fixtures/regtest-blocks.json' with { type: 'json' };
import { HeaderError, parseBlockHeader } from './header.ts';
import { checkChainIdentity, type IdentityInput } from './identity.ts';
import { readFileSync } from 'node:fs';
import { BLAKE2B_ACTIVATION_HEIGHT, FORK_VERSIONS, hasFeature, versionTested } from './profile.ts';

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

describe('parseBlockHeader: transaction count', () => {
  const header = sha256d.block.slice(0, 160);
  it('reads every width of the count when it is canonical', () => {
    expect(parseBlockHeader(header + 'fc').txCount).toBe(252n);
    expect(parseBlockHeader(header + 'fdfd00').txCount).toBe(253n);
    expect(parseBlockHeader(header + 'fe00000100').txCount).toBe(65_536n);
    expect(parseBlockHeader(header + 'ff0000000001000000').txCount).toBe(4_294_967_296n);
  });

  it('refuses truncated and non-canonical counts and blocks too short to have a version', () => {
    for (const count of ['fd01', 'fe000001', 'ff00000000010000', 'fdfc00', 'feffff0000', 'ffffffffff00000000']) {
      expect(() => parseBlockHeader(header + count), count).toThrow(HeaderError);
    }
    expect(() => parseBlockHeader('0000')).toThrow(HeaderError);
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

  it('dates the result with the current time when no time is given', () => {
    const withoutNow: IdentityInput = { ...input('bitcoin', sha256d) };
    delete withoutNow.now;
    const before = Date.now();
    expect(Date.parse(checkChainIdentity(withoutNow).checkedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('refuses unreadable feature bits', () => {
    expect(checkChainIdentity(input('blake2b', blake2b, { features: 'zz' }))).toMatchObject({
      state: 'refused',
      failedCheck: 'software',
    });
  });

  it('refuses a stock node whose backend follows the BLAKE2b chain under the Bitcoin profile (header)', () => {
    const wrongBackend = { ...input('bitcoin', sha256d), tip: { height: blake2b.height, raw: blake2b.block } };
    expect(checkChainIdentity(wrongBackend)).toMatchObject({ state: 'refused', failedCheck: 'header' });
  });

  it('waits on an unsynced backend under the Bitcoin profile too', () => {
    expect(checkChainIdentity(input('bitcoin', sha256d, { synced: false }))).toMatchObject({
      state: 'waiting',
      failedCheck: 'sync',
    });
  });

  it('uses the activation height of each network: testnet4 at 150,308', () => {
    const at = (blockHeight: number) => ({
      ...input('blake2b', blake2b, { network: 'testnet4', networkRaw: 'testnet4', blockHeight }),
      network: 'testnet4' as Network,
    });
    expect(BLAKE2B_ACTIVATION_HEIGHT).toEqual({ mainnet: 961_640, testnet4: 150_308, signet: null, regtest: 1 });
    expect(checkChainIdentity(at(150_307))).toMatchObject({ state: 'waiting', failedCheck: 'fork_height' });
    expect(checkChainIdentity(at(150_308))).toMatchObject({ state: 'confirmed' });
  });

  it('cleans and shortens the network name the node reports before putting it in the detail', () => {
    const rlo = String.fromCharCode(0x202e);
    const odd = input('bitcoin', sha256d, { network: 'unknown', networkRaw: `liq${rlo}uid${'x'.repeat(100)}` });
    const detail = checkChainIdentity(odd).detail ?? '';
    expect(detail).not.toContain(rlo);
    expect(detail.startsWith(`node is on liquid${'x'.repeat(26)}, profile`)).toBe(true);
  });
});

describe('fork-version table', () => {
  it('matches the CLN pins of tools/regtest/versions.json', () => {
    const pins = JSON.parse(readFileSync(new URL('../../../tools/regtest/versions.json', import.meta.url), 'utf8')) as {
      blake2b: { cln: { version: string } };
      sha256d: { cln: { version: string } };
    };
    expect(FORK_VERSIONS.blake2b.cln).toBe(pins.blake2b.cln.version);
    expect(FORK_VERSIONS.bitcoin.cln).toBe(pins.sha256d.cln.version);
  });

  it('tells tested versions from others, reading only the first word of LND versions', () => {
    expect(versionTested('blake2b', 'cln', 'v26.06.9-blake2b.7')).toBe(true);
    expect(versionTested('blake2b', 'cln', 'v26.06.9-blake2b.7-2-g67513b1')).toBe(false);
    expect(versionTested('bitcoin', 'cln', 'v26.06.9-blake2b.7')).toBe(false);
    expect(versionTested('blake2b', 'lnd', '0.21.4-beta-blake2b.18 commit=')).toBe(true);
    expect(versionTested('bitcoin', 'lnd', '0.21.4-beta commit=')).toBe(true);
    expect(versionTested('bitcoin', 'lnd', '')).toBe(false);
  });
});
