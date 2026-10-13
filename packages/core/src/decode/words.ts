// Bech32 5-bit words: numbers are big-endian across words, and byte fields are packed 5 bits at a time with zero
// bits at the end. Written here rather than with `bech32.fromWords` because that refuses any leftover bits, and a
// BOLT11 signature covers data whose length (35-bit timestamp plus fields) is rarely a multiple of 8 bits.

// Big-endian number from words. Only for at most 10 words (50 bits), so the result stays an exact JS number.
export const wordsToNumber = (words: readonly number[]): number => words.reduce((n, w) => n * 32 + w, 0);

// Big-endian number of any size.
export const wordsToBigInt = (words: readonly number[]): bigint => words.reduce((n, w) => (n << 5n) | BigInt(w), 0n);

// Packs the words into bytes; a last partial byte is padded with zero bits (the BOLT11 signing rule).
export function wordsToBytesPadded(words: readonly number[]): Uint8Array {
  const out = new Uint8Array(Math.ceil((words.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[i++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0) out[i] = (acc << (8 - bits)) & 0xff;
  return out;
}

// Packs the words into whole bytes and drops the leftover bits. Returns undefined, as BIP173 requires, when there
// are 5 or more leftover bits (a whole word of padding) or a leftover bit is set: writers pad with at most 4 zero
// bits, so anything else means the field is not what it claims to be.
export function wordsToBytes(words: readonly number[]): Uint8Array | undefined {
  const padded = wordsToBytesPadded(words);
  const whole = Math.floor((words.length * 5) / 8);
  if ((words.length * 5) % 8 >= 5) return undefined;
  // All leftover bits sit in the padded last byte.
  if (padded.length > whole && padded[whole] !== 0) return undefined;
  return padded.slice(0, whole);
}

// Unpacks bytes into words, zero-padding the last word.
export function bytesToWords(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
