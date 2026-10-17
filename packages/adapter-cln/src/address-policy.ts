import { BlockList, isIP } from 'node:net';

// Node management accepts loopback, private LAN and Tailscale (CGNAT) endpoints. The check runs on each DNS
// resolution, so a hostname cannot be admitted on a private answer and later rebind to a public endpoint.
const ALLOWED = new BlockList();
ALLOWED.addSubnet('127.0.0.0', 8, 'ipv4');
ALLOWED.addSubnet('10.0.0.0', 8, 'ipv4');
ALLOWED.addSubnet('172.16.0.0', 12, 'ipv4');
ALLOWED.addSubnet('192.168.0.0', 16, 'ipv4');
// Shared address space (RFC 6598): not publicly routed; Tailscale gives its nodes addresses here.
ALLOWED.addSubnet('100.64.0.0', 10, 'ipv4');
ALLOWED.addAddress('::1', 'ipv6');
// Unique local (RFC 4193), Tailscale's IPv6 range included. A range, not a text prefix: `fc::1` is `00fc::1`.
ALLOWED.addSubnet('fc00::', 7, 'ipv6');

export function isNodeAddress(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) return isNodeAddress(ip.slice(7));
  const family = isIP(ip);
  if (family === 4) return ALLOWED.check(ip, 'ipv4');
  if (family === 6) return ALLOWED.check(ip, 'ipv6');
  return false;
}
