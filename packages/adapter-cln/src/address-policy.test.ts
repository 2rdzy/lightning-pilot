import { expect, it } from 'vitest';
import { isNodeAddress } from './address-policy.ts';
it('permits loopback and private LAN endpoints and refuses public, link-local and unspecified addresses', () => {
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
    'invalid',
  ])
    expect(isNodeAddress(ip), ip).toBe(false);
});
