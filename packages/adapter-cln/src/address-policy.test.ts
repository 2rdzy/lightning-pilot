import { expect, it } from 'vitest';
import { isNodeAddress } from './address-policy.ts';
it('permits loopback, private LAN and Tailscale endpoints and refuses public, link-local and unspecified addresses', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.2',
    '172.16.0.1',
    '172.31.255.1',
    '192.168.1.3',
    '::1',
    'fd00::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    // Tailscale: CGNAT IPv4 and its unique-local IPv6 range.
    '100.64.0.1',
    '100.101.102.103',
    '100.127.255.254',
    'fd7a:115c:a1e0::1',
    'FDFF::1',
  ])
    expect(isNodeAddress(ip), ip).toBe(true);
  for (const ip of [
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '::',
    'fe80::1',
    '2001:4860::1',
    '::ffff:8.8.8.8',
    // Just outside the CGNAT range.
    '100.63.255.255',
    '100.128.0.1',
    // `fc::1` is `00fc::1`, not unique local; neither are the neighbours of fc00::/7.
    'fc::1',
    'fd::1',
    'fbff::1',
    'fe00::1',
    '::ffff:808:808',
    'invalid',
  ])
    expect(isNodeAddress(ip), ip).toBe(false);
});
