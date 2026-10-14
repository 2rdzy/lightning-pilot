import { describe, expect, it } from 'vitest';
import { canonicalAddress, deviceDigest, digest, directSource } from './source.ts';
import { randomBytes } from 'node:crypto';

describe('login source identity', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::FFFF:c000:201', '192.0.2.1'],
    ['::1', '0000:0000:0000:0000:0000:0000:0000:0001'],
    ['2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001'],
    ['2001:0DB8:1:2:3:4:5:6', '2001:0db8:0001:0002:0003:0004:0005:0006'],
    ['[::1]', undefined],
    ['192.0.2.1:80', undefined],
    ['192.00.2.1', undefined],
    ['fe80::1%eth0', undefined],
    ['', undefined],
    ['https://evil.test', undefined],
  ])('canonicalises %s without URL, port or zone syntax', (address, expected) => {
    expect(canonicalAddress(address)).toBe(expected);
  });

  it('groups IPv6 /64 but keeps IPv4 addresses separate, including mapped addresses', () => {
    const source = (peerAddress: string) => directSource({ peerAddress }, []);
    expect(source('2001:db8:1:2::1')).toEqual(source('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'));
    expect(source('2001:db8:1:3::1').counter).not.toBe(source('2001:db8:1:2::1').counter);
    expect(source('::ffff:192.0.2.1')).toEqual(source('192.0.2.1'));
    expect(source('192.0.2.2').counter).not.toBe(source('192.0.2.1').counter);
    expect(source('2001:db8:1:2::1').descriptor).toBe('2001:0db8:0001:0002::/64');
  });

  it.each([
    { peerAddress: '192.0.2.2', forwardedFor: '198.51.100.1', trusted: ['192.0.2.1'], result: '192.0.2.2' },
    { peerAddress: '192.0.2.1', forwardedFor: '198.51.100.1', trusted: ['192.0.2.1'], result: '198.51.100.1' },
    { peerAddress: '::ffff:192.0.2.1', forwardedFor: '198.51.100.1', trusted: ['192.0.2.1'], result: '198.51.100.1' },
    {
      peerAddress: '192.0.2.1',
      forwardedFor: '203.0.113.9, 198.51.100.1, 192.0.2.3',
      trusted: ['192.0.2.1', '192.0.2.3'],
      result: '198.51.100.1',
    },
    {
      peerAddress: '2001:db8::2',
      forwardedFor: '198.51.100.1',
      trusted: ['2001:db8::1'],
      result: '2001:0db8:0000:0000::/64',
    },
    { peerAddress: '192.0.2.1', forwardedFor: '198.51.100.1, invalid', trusted: ['192.0.2.1'], result: '192.0.2.1' },
    { peerAddress: '192.0.2.1', forwardedFor: 'x'.repeat(1025), trusted: ['192.0.2.1'], result: '192.0.2.1' },
    {
      peerAddress: '192.0.2.1',
      forwardedFor: Array<string>(17).fill('198.51.100.1').join(','),
      trusted: ['192.0.2.1'],
      result: '192.0.2.1',
    },
    { peerAddress: '192.0.2.1', trusted: ['192.0.2.1'], result: '192.0.2.1' },
    { forwardedFor: '198.51.100.1', trusted: ['192.0.2.1'], result: 'unknown-direct' },
  ])('uses only a valid chain behind an exactly trusted peer: $result', ({ trusted, result, ...origin }) => {
    const { descriptor, counter } = directSource(origin, trusted);
    expect(descriptor).toBe(result);
    expect(counter).toBe(`ip:${digest(result)}`);
  });

  it('uses a shared anonymous Tor counter only from the trusted listener property', () => {
    expect(
      directSource({ transport: 'tor', peerAddress: '127.0.0.1', forwardedFor: '198.51.100.1' }, ['127.0.0.1']),
    ).toEqual({ kind: 'tor', counter: 'tor', descriptor: 'tor' });
    expect(directSource({ transport: 'direct', peerAddress: '127.0.0.1' }, []).kind).toBe('ip');
    expect(directSource({}, []).descriptor).toBe('unknown-direct');
    expect(directSource({ peerAddress: 'invalid' }, []).descriptor).toBe('unknown-direct');
  });

  it('recognises only canonical 256-bit device cookies and returns just their hash', () => {
    const cookie = randomBytes(32).toString('base64url');
    expect(deviceDigest(cookie)).toBe(digest(cookie));
    for (const value of [undefined, '', 'a'.repeat(44), '!'.repeat(43), 'A'.repeat(42) + 'B', cookie + '='])
      expect(deviceDigest(value)).toBeUndefined();
  });
});
