import { beforeAll, describe, expect, it } from 'vitest';
import { EXPORT_FILE_BYTES, EXPORT_PLAINTEXT_BYTES, type ExportEnvelope } from '@lightning-pilot/core';
import { decryptExport, encryptExport } from './crypto.ts';

const passphrase = 'a sufficiently long e\u0301 passphrase 🔑';
const plaintext = Buffer.from('{"version":1,"message":"portable settings"}');
const generic = { code: 'validation_failed', message: 'The export or passphrase is not valid.' };
const changed = (value: string) => {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString('base64');
};

describe('portable export encryption with production scrypt costs', () => {
  let envelope: ExportEnvelope;
  beforeAll(async () => {
    envelope = await encryptExport(plaintext, passphrase);
  });

  it('round trips the exact UTF-8 passphrase without normalization', async () => {
    expect(await decryptExport(envelope, passphrase)).toEqual(plaintext);
    await expect(decryptExport(envelope, passphrase.normalize('NFC'))).rejects.toMatchObject(generic);
    await expect(decryptExport(envelope, 'a different long passphrase')).rejects.toMatchObject(generic);
  });

  it('uses fresh salt and nonce for each export', async () => {
    const other = await encryptExport(plaintext, passphrase);
    expect(other.kdf.salt === envelope.kdf.salt).toBe(false);
    expect(other.cipher.nonce === envelope.cipher.nonce).toBe(false);
    expect(other.ciphertext === envelope.ciphertext).toBe(false);
    expect(other.cipher.tag === envelope.cipher.tag).toBe(false);
  });

  it.each(['salt', 'nonce', 'tag', 'ciphertext', 'truncated ciphertext'] as const)(
    'returns the same generic error for modified %s',
    async (field) => {
      const candidate = structuredClone(envelope);
      if (field === 'salt') candidate.kdf.salt = changed(candidate.kdf.salt);
      else if (field === 'nonce' || field === 'tag') candidate.cipher[field] = changed(candidate.cipher[field]);
      else if (field === 'ciphertext') candidate.ciphertext = changed(candidate.ciphertext);
      else candidate.ciphertext = Buffer.from(candidate.ciphertext, 'base64').subarray(1).toString('base64');
      await expect(decryptExport(candidate, passphrase)).rejects.toMatchObject(generic);
    },
  );

  it('rejects unsupported headers, algorithms, costs and unknown fields', async () => {
    for (const candidate of [
      { ...envelope, format: 'another-format' },
      { ...envelope, version: 2 },
      { ...envelope, ownerHash: 'excluded' },
      { ...envelope, kdf: { ...envelope.kdf, name: 'pbkdf2' } },
      { ...envelope, kdf: { ...envelope.kdf, N: 262144 } },
      { ...envelope, kdf: { ...envelope.kdf, r: 16 } },
      { ...envelope, kdf: { ...envelope.kdf, p: 2 } },
      { ...envelope, cipher: { ...envelope.cipher, name: 'aes-256-cbc' } },
      null,
      undefined,
      '{truncated',
    ])
      await expect(decryptExport(candidate, passphrase)).rejects.toMatchObject(generic);
  });

  it('rejects malformed base64, incorrect lengths and noncanonical pad bits', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const salt = envelope.kdf.salt;
    const index = salt.length - 3;
    const last = salt[index];
    if (!last) throw new Error('Missing salt test content');
    const noncanonical = salt.slice(0, index) + alphabet[alphabet.indexOf(last) + 1] + '==';
    expect(Buffer.from(noncanonical, 'base64').equals(Buffer.from(salt, 'base64'))).toBe(true);
    for (const badSalt of [salt + '\n', salt.replaceAll('=', ''), '!!!!', noncanonical, 'AAAA'])
      await expect(
        decryptExport({ ...envelope, kdf: { ...envelope.kdf, salt: badSalt } }, passphrase),
      ).rejects.toMatchObject(generic);
    for (const field of ['nonce', 'tag'] as const)
      await expect(
        decryptExport({ ...envelope, cipher: { ...envelope.cipher, [field]: 'AAAA' } }, passphrase),
      ).rejects.toMatchObject(generic);
    await expect(decryptExport({ ...envelope, ciphertext: '!!!!' }, passphrase)).rejects.toMatchObject(generic);
  });

  it('rejects plaintext and envelope sizes above their independent limits', async () => {
    await expect(encryptExport(Buffer.alloc(EXPORT_PLAINTEXT_BYTES + 1), passphrase)).rejects.toMatchObject(generic);
    await expect(
      decryptExport(
        { ...envelope, ciphertext: Buffer.alloc(EXPORT_PLAINTEXT_BYTES + 1).toString('base64') },
        passphrase,
      ),
    ).rejects.toMatchObject(generic);
    await expect(
      decryptExport({ ...envelope, ciphertext: 'A'.repeat(EXPORT_FILE_BYTES + 1) }, passphrase),
    ).rejects.toMatchObject(generic);
  });
});
