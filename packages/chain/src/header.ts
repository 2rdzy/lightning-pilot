// Block header parsing for the chain identity check. A BLAKE2b block has a 164-byte header with the top bit of
// `version` set; a Bitcoin block has an 80-byte header without it. A block that does not parse in the format its
// version bit claims is refused.

export class HeaderError extends Error {}

export interface ParsedHeader {
  version: number;
  versionTopBit: boolean;
  headerBytes: number;
  txCount: bigint;
}

const VERSION_TOP_BIT = 0x80000000;

function readVarInt(bytes: Uint8Array, offset: number): bigint {
  const first = bytes[offset];
  if (first === undefined) throw new HeaderError('no transaction count after the header');
  const width = first < 0xfd ? 0 : first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (width === 0) return BigInt(first);
  if (offset + 1 + width > bytes.length) throw new HeaderError('truncated transaction count');
  let value = 0n;
  for (let i = width; i >= 1; i--) value = (value << 8n) | BigInt(bytes[offset + i] ?? 0);
  // Non-canonical encodings (a wider form than needed) are invalid in Bitcoin's serialisation.
  const minimum = width === 2 ? 0xfdn : width === 4 ? 0x10000n : 0x100000000n;
  if (value < minimum) throw new HeaderError('non-canonical transaction count');
  return value;
}

export function parseBlockHeader(hex: string): ParsedHeader {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new HeaderError('block is not hex');
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  if (bytes.length < 4) throw new HeaderError('block too short');
  const version = ((bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 24)) >>> 0;
  const versionTopBit = (version & VERSION_TOP_BIT) !== 0;
  const headerBytes = versionTopBit ? 164 : 80;
  if (bytes.length <= headerBytes) throw new HeaderError(`block shorter than its ${headerBytes}-byte header`);
  const txCount = readVarInt(bytes, headerBytes);
  // Every block has at least its coinbase transaction.
  if (txCount < 1n) throw new HeaderError('block without transactions');
  return { version, versionTopBit, headerBytes, txCount };
}
