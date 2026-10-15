import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { AppError, ExportEnvelope, EXPORT_FILE_BYTES, EXPORT_PLAINTEXT_BYTES } from '@lightning-pilot/core';

export const invalidExport = () => new AppError('validation_failed', 'The export or passphrase is not valid.');
const aad = (e: ExportEnvelope) =>
  Buffer.from(
    JSON.stringify([
      e.format,
      e.version,
      e.kdf.name,
      e.kdf.N,
      e.kdf.r,
      e.kdf.p,
      e.kdf.salt,
      e.cipher.name,
      e.cipher.nonce,
    ]),
  );
function decode(text: string, length?: number): Buffer {
  const value = Buffer.from(text, 'base64');
  if (value.toString('base64') !== text || (length !== undefined && value.length !== length)) throw invalidExport();
  return value;
}
async function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  const password = Buffer.from(passphrase, 'utf8');
  try {
    return await new Promise((resolve, reject) =>
      scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (err, key) =>
        err ? reject(err) : resolve(key),
      ),
    );
  } finally {
    password.fill(0);
  }
}
export async function encryptExport(plain: Buffer, passphrase: string): Promise<ExportEnvelope> {
  if (plain.length > EXPORT_PLAINTEXT_BYTES) throw invalidExport();
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await derive(passphrase, salt);
  try {
    const header: ExportEnvelope = {
      format: 'lightning-pilot-export',
      version: 1,
      kdf: { name: 'scrypt', N: 131072, r: 8, p: 1, salt: salt.toString('base64') },
      cipher: { name: 'aes-256-gcm', nonce: nonce.toString('base64'), tag: '' },
      ciphertext: '',
    };
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(header));
    header.ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
    header.cipher.tag = cipher.getAuthTag().toString('base64');
    return header;
  } finally {
    key.fill(0);
  }
}
export async function decryptExport(input: unknown, passphrase: string): Promise<Buffer> {
  try {
    // Validate algorithms and costs before the file can cause expensive work.
    if (Buffer.byteLength(JSON.stringify(input)) > EXPORT_FILE_BYTES) throw invalidExport();
    const e = ExportEnvelope.parse(input);
    const salt = decode(e.kdf.salt, 16),
      nonce = decode(e.cipher.nonce, 12),
      tag = decode(e.cipher.tag, 16);
    const ciphertext = decode(e.ciphertext);
    if (ciphertext.length > EXPORT_PLAINTEXT_BYTES) throw invalidExport();
    const key = await derive(passphrase, salt);
    let first: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aad(e));
      decipher.setAuthTag(tag);
      first = decipher.update(ciphertext);
      return Buffer.concat([first, decipher.final()]);
    } finally {
      first?.fill(0);
      key.fill(0);
    }
  } catch {
    throw invalidExport();
  }
}
