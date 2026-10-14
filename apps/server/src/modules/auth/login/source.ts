import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export interface LoginOrigin {
  peerAddress?: string;
  forwardedFor?: string;
  // Set by the server serving a listener, never by a request header.
  transport?: 'direct' | 'tor';
}

export interface LoginSource {
  kind: 'device' | 'ip' | 'tor';
  counter: string;
  descriptor: string;
}

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const DEVICE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export function deviceDigest(cookie: string | undefined): string | undefined {
  if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return undefined;
  const decoded = Buffer.from(cookie, 'base64url');
  return decoded.toString('base64url') === cookie ? digest(cookie) : undefined;
}

// WHATWG URL parsing expands embedded IPv4 and compresses IPv6 consistently. isIP rejects URL syntax,
// brackets, zone IDs and ports before it gets here, so headers cannot smuggle another identity through it.
export function canonicalAddress(address: string): string | undefined {
  if (address.includes('%')) return undefined;
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;
  const compressed = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = compressed.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups = compressed.includes('::')
    ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
    : head;
  const words = groups.map((word) => parseInt(word, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return words
      .slice(6)
      .flatMap((word) => [word >>> 8, word & 255])
      .join('.');
  }
  return words.map((word) => word.toString(16).padStart(4, '0')).join(':');
}

export function directSource(origin: LoginOrigin, trustedProxies: readonly string[]): LoginSource {
  if (origin.transport === 'tor') return { kind: 'tor', counter: 'tor', descriptor: 'tor' };
  const peer = origin.peerAddress && canonicalAddress(origin.peerAddress);
  let address = peer || undefined;
  const trusted = new Set(trustedProxies.map(canonicalAddress));
  const forwarded = origin.forwardedFor;
  if (peer && trusted.has(peer) && forwarded && forwarded.length <= 1024) {
    const hops = forwarded.split(',');
    if (hops.length <= 16) {
      const parsed = hops.map((hop) => canonicalAddress(hop.trim()));
      if (parsed.every((hop) => hop !== undefined)) {
        for (const hop of parsed.reverse()) {
          address = hop;
          if (!trusted.has(hop)) break;
        }
      }
    }
  }
  const descriptor = address?.includes(':')
    ? `${address.split(':').slice(0, 4).join(':')}::/64`
    : (address ?? 'unknown-direct');
  return { kind: 'ip', counter: `ip:${digest(descriptor)}`, descriptor };
}
