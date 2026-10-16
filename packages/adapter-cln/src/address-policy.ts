import { isIP } from 'node:net';

// Node management accepts loopback and private LAN endpoints. The check runs on each DNS resolution, so a
// hostname cannot be admitted on a private answer and later rebind to a public endpoint.
export function isNodeAddress(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip.startsWith('::ffff:')) return isNodeAddress(ip.slice(7));
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(ip) !== 6) return false;
  return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd');
}
