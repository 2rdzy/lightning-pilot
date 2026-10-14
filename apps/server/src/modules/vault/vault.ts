// The credential vault. Node credentials are encrypted at rest with AES-256-GCM under the vault key: a random 96-bit
// nonce per write, and additional data `key_id|node_id|kind` binding each ciphertext to its key and row. The key is a
// random 256-bit value made by the install script and handed to the app as a file by the service manager; the app
// never creates, stores or prints it, and never reads it from an environment variable. Every doubt stops start-up.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Db } from '../../storage/db.ts';

export class VaultError extends Error {}

export type CredentialKind = 'read' | 'spend';
export type SecretPurpose = 'totp' | 'telegram_token' | `intent_psbt:${string}`;

// File content: 64 hexadecimal characters (32 bytes) and an optional newline; anything else is refused.
export function loadVaultKey(path: string): Buffer {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new VaultError('vault key not provided');
  }
  if (!/^[0-9a-f]{64}\n?$/.test(text)) throw new VaultError('vault key malformed');
  return Buffer.from(text.slice(0, 64), 'hex');
}

// Not secret: shown in messages and logs, stored next to every ciphertext.
export const keyIdOf = (key: Buffer): string => createHash('sha256').update(key).digest('hex').slice(0, 16);

const CANARY = Buffer.from('lightning-pilot-canary');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function seal(key: Buffer, plain: Buffer, aad: string) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return { nonce, ciphertext: Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]) };
}

function open(key: Buffer, nonce: Uint8Array, blob: Uint8Array, aad: string): Buffer {
  const data = Buffer.from(blob);
  if (nonce.length !== NONCE_BYTES || data.length <= TAG_BYTES) throw new VaultError('corrupt value');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new VaultError('value cannot be decrypted (wrong key or tampered data)');
  }
}

async function setting(db: Db, key: string): Promise<string | undefined> {
  return (await db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst())?.value;
}

export class Vault {
  readonly keyId: string;
  #key: Buffer;
  #initialised: boolean;
  #closed = false;

  // The vault keeps its own copy of the key: the caller wipes the buffer it read from the file once start() returns.
  private constructor(key: Buffer, initialised: boolean) {
    this.#key = Buffer.from(key);
    this.keyId = keyIdOf(key);
    this.#initialised = initialised;
  }

  get initialised(): boolean {
    return this.#initialised;
  }

  // Start-up checks (fail closed). An empty database starts uninitialised (setup mode); the canary is written only
  // by initialise() when setup completes, and is never re-created when missing.
  static async start(db: Db, key: Buffer): Promise<Vault> {
    const keyId = keyIdOf(key);
    const storedId = await setting(db, 'vault_key_id');
    const canary = await setting(db, 'vault_canary');
    const hasSecrets = (await db.selectFrom('credentials').select('node_id').limit(1).executeTakeFirst()) !== undefined;
    if (storedId === undefined && canary === undefined) {
      if (
        hasSecrets ||
        (await db.selectFrom('auth_totp').select('id').executeTakeFirst()) !== undefined ||
        (await setting(db, 'setup_alerts')) !== undefined
      )
        throw new VaultError('vault canary missing');
      return new Vault(key, false);
    }
    if (storedId !== undefined && storedId !== keyId) {
      throw new VaultError(`vault key ${keyId} does not match this database (${storedId})`);
    }
    if (canary === undefined || storedId === undefined) throw new VaultError('vault canary missing');
    const blob = Buffer.from(canary, 'base64');
    try {
      open(key, blob.subarray(0, NONCE_BYTES), blob.subarray(NONCE_BYTES), `${keyId}|canary`);
    } catch {
      throw new VaultError('wrong vault key or damaged database');
    }
    return new Vault(key, true);
  }

  // Called once, inside the transaction that completes setup. If that transaction rolls back, the caller calls
  // reload() so the in-memory state follows the database again.
  async initialise(trx: Db): Promise<void> {
    this.#open();
    if ((await setting(trx, 'vault_key_id')) !== undefined) {
      throw new VaultError('vault already initialised');
    }
    const { nonce, ciphertext } = seal(this.#key, CANARY, `${this.keyId}|canary`);
    await trx
      .insertInto('settings')
      .values([
        { key: 'vault_key_id', value: this.keyId },
        { key: 'vault_canary', value: Buffer.concat([nonce, ciphertext]).toString('base64') },
      ])
      .execute();
    this.#initialised = true;
  }

  async reload(db: Db): Promise<void> {
    this.#initialised = (await setting(db, 'vault_canary')) !== undefined;
  }

  async put(trx: Db, nodeId: string, kind: CredentialKind, secret: string): Promise<void> {
    this.#open();
    if (!this.#initialised) throw new VaultError('vault not initialised');
    const { nonce, ciphertext } = seal(this.#key, Buffer.from(secret, 'utf8'), `${this.keyId}|${nodeId}|${kind}`);
    await trx
      .insertInto('credentials')
      .values({ node_id: nodeId, kind, key_id: this.keyId, nonce, ciphertext })
      .onConflict((oc) => oc.columns(['node_id', 'kind']).doUpdateSet({ key_id: this.keyId, nonce, ciphertext }))
      .execute();
  }

  async get(db: Db, nodeId: string, kind: CredentialKind): Promise<string | undefined> {
    this.#open();
    const row = await db
      .selectFrom('credentials')
      .select(['key_id', 'nonce', 'ciphertext'])
      .where('node_id', '=', nodeId)
      .where('kind', '=', kind)
      .executeTakeFirst();
    if (!row) return undefined;
    if (row.key_id !== this.keyId) throw new VaultError('credential encrypted under another key');
    return open(this.#key, row.nonce, row.ciphertext, `${this.keyId}|${nodeId}|${kind}`).toString('utf8');
  }

  // Owner/service secrets have their own tables; the AAD names their purpose, never a node credential row. A spend
  // intent's PSBT is bound to its intent id (`intent_psbt:<id>`), so it cannot be moved to another intent.
  sealSecret(secret: string, purpose: SecretPurpose) {
    this.#open();
    if (!this.#initialised) throw new VaultError('vault not initialised');
    const sealed = seal(this.#key, Buffer.from(secret), `${this.keyId}|${purpose}`);
    return { key_id: this.keyId, ...sealed };
  }

  openSecret(value: { key_id: string; nonce: Uint8Array; ciphertext: Uint8Array }, purpose: SecretPurpose): string {
    this.#open();
    if (value.key_id !== this.keyId) throw new VaultError('secret encrypted under another key');
    return open(this.#key, value.nonce, value.ciphertext, `${this.keyId}|${purpose}`).toString('utf8');
  }

  // Wipes the key; the vault refuses every use afterwards.
  close(): void {
    this.#key.fill(0);
    this.#closed = true;
  }

  #open(): void {
    if (this.#closed) throw new VaultError('vault closed');
  }
}
