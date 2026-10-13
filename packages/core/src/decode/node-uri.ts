// Node URIs: `<pubkey>[@<host>[:<port>]]`, as nodes print them (CLN `getinfo.address`, LND `uris`). The host is an
// IPv4 address, a bracketed IPv6 address, a DNS name or a Tor v3 `.onion` name.
import { hexToBytes } from '@noble/hashes/utils.js';
import { Point } from '@noble/secp256k1';
import { parsePubkey, type Pubkey } from '../ids.ts';
import { DecodeError } from './errors.ts';

export interface NodeUri {
  pubkey: Pubkey;
  host?: string;
  port?: number;
}

export const DEFAULT_LIGHTNING_PORT = 9735;

const PUBKEY = /^0[23][0-9a-f]{64}$/;
const IPV4 = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;
const ONION_V3 = /^[a-z2-7]{56}\.onion$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isNodePubkey(text: string): boolean {
  return PUBKEY.test(text.toLowerCase());
}

function readHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) {
    // The URL parser knows every IPv6 form; it needs the brackets.
    try {
      return new URL(`http://${lower}/`).hostname;
    } catch {
      throw new DecodeError('malformed', 'The node address is not valid.');
    }
  }
  if (IPV4.test(lower) || ONION_V3.test(lower)) return lower;
  const labels = lower.split('.');
  // A DNS name: two or more labels, the last one not all digits (that would be a bad IPv4 address).
  if (
    lower.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    !/^[0-9]+$/.test(labels[labels.length - 1] ?? '')
  ) {
    return lower;
  }
  throw new DecodeError('malformed', 'The node address is not valid.');
}

export function decodeNodeUri(input: string): NodeUri {
  const text = input.trim();
  const at = text.indexOf('@');
  const key = (at === -1 ? text : text.slice(0, at)).toLowerCase();
  if (!PUBKEY.test(key)) throw new DecodeError('malformed', 'Not a node public key.');
  try {
    Point.fromBytes(hexToBytes(key));
  } catch {
    throw new DecodeError('malformed', 'Not a node public key.');
  }
  const pubkey = parsePubkey(key);
  if (at === -1) return { pubkey };

  const address = text.slice(at + 1);
  // The port follows the last colon outside IPv6 brackets.
  const colon = address.lastIndexOf(':');
  const hasPort = colon !== -1 && colon > address.lastIndexOf(']');
  const host = readHost(hasPort ? address.slice(0, colon) : address);
  if (!hasPort) return { pubkey, host, port: DEFAULT_LIGHTNING_PORT };
  const portText = address.slice(colon + 1);
  const port = /^[0-9]{1,5}$/.test(portText) ? Number(portText) : 0;
  if (port < 1 || port > 65535) throw new DecodeError('malformed', 'The node port is not valid.');
  return { pubkey, host, port };
}
