// Authentication (minimal): the one-time setup token, the owner's password and server-side sessions. TOTP, login
// throttling, step-up and the session list come in later work packages.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { AppError } from '@lightning-pilot/core';
import { writeTx, type Db } from '../../storage/db.ts';
import type { Logger } from '../../logging/logger.ts';
import type { Vault } from '../vault/index.ts';

// scrypt with N = 2^17, r = 8, p = 1 (Node's built-in; no extra package). maxmem is raised because these
// parameters need 128 MiB, above Node's default limit.
export interface ScryptCost {
  log2N: number;
  r: number;
  p: number;
}
export const DEFAULT_SCRYPT: ScryptCost = { log2N: 17, r: 8, p: 1 };

const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
// last_seen_at is written at most this often, so reads do not turn into writes.
const TOUCH_INTERVAL_MS = 60 * 1000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function scrypt(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  const N = 2 ** cost.log2N;
  const options: ScryptOptions = { N, r: cost.r, p: cost.p, maxmem: 256 * N * cost.r };
  return new Promise((resolve, reject) =>
    scryptCallback(password.normalize('NFKC'), salt, 32, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string, cost: ScryptCost = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, cost);
  return ['scrypt', cost.log2N, cost.r, cost.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, log2N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  let actual: Buffer;
  try {
    actual = await scrypt(password, Buffer.from(salt, 'base64'), { log2N: Number(log2N), r: Number(r), p: Number(p) });
  } catch {
    // Parameters scrypt refuses (a damaged hash): never a match.
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

// 136 random bits as 28 base32 characters in groups of four.
function newSetupToken(): string {
  const bytes = randomBytes(17);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // 136 bits leave one bit over: it becomes the last character.
  out += BASE32[(value << (5 - bits)) & 31];
  return Array.from({ length: Math.ceil(out.length / 4) }, (_, i) => out.slice(i * 4, i * 4 + 4)).join('-');
}

const normaliseToken = (token: string) => token.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface AuthOptions {
  db: Db;
  vault: Vault;
  logger: Logger;
  setupUrl: string;
  scryptCost?: ScryptCost;
  now?: () => Date;
}

export interface NewSession {
  cookieValue: string;
  csrfToken: string;
  expiresAt: Date;
}

export class AuthService {
  readonly #db: Db;
  readonly #vault: Vault;
  readonly #log: Logger;
  readonly #setupUrl: string;
  readonly #cost: ScryptCost;
  readonly #now: () => Date;
  #ownerExists = false;

  private constructor(options: AuthOptions) {
    this.#db = options.db;
    this.#vault = options.vault;
    this.#log = options.logger.child('auth');
    this.#setupUrl = options.setupUrl;
    this.#cost = options.scryptCost ?? DEFAULT_SCRYPT;
    this.#now = options.now ?? (() => new Date());
  }

  static async create(options: AuthOptions): Promise<AuthService> {
    const service = new AuthService(options);
    service.#ownerExists = (await options.db.selectFrom('owner').select('id').executeTakeFirst()) !== undefined;
    return service;
  }

  get setupMode(): boolean {
    return !this.#ownerExists;
  }

  // In setup mode, every start issues a new token and invalidates the old one. Only its hash is stored; the token
  // itself goes to the service log once.
  async issueSetupToken(): Promise<void> {
    if (this.#ownerExists) return;
    const token = newSetupToken();
    const expiresAt = new Date(this.#now().getTime() + SETUP_TOKEN_TTL_MS).toISOString();
    const tokenHash = sha256(normaliseToken(token));
    await this.#db
      .insertInto('setup_token')
      .values({ id: 1, token_hash: tokenHash, expires_at: expiresAt })
      .onConflict((oc) => oc.column('id').doUpdateSet({ token_hash: tokenHash, expires_at: expiresAt }))
      .execute();
    this.#log.setupToken(token, this.#setupUrl);
  }

  async completeSetup(token: string, password: string, requestId: string): Promise<void> {
    const row = await this.#db.selectFrom('setup_token').selectAll().executeTakeFirst();
    const valid =
      row !== undefined &&
      Date.parse(row.expires_at) > this.#now().getTime() &&
      equalHex(sha256(normaliseToken(token)), row.token_hash);
    if (!valid) {
      this.#log.warn('setup token refused', { requestId });
      throw new AppError('setup_token_invalid', 'The setup token is not valid.');
    }
    const passwordHash = await hashPassword(password, this.#cost);
    try {
      await writeTx(this.#db, async (trx) => {
        const exists = await trx.selectFrom('owner').select('id').executeTakeFirst();
        if (exists) throw new AppError('not_found', 'Not found.');
        await trx
          .insertInto('owner')
          .values({ id: 1, password_hash: passwordHash, created_at: this.#now().toISOString() })
          .execute();
        await trx.deleteFrom('setup_token').execute();
        await this.#vault.initialise(trx);
      });
    } catch (err) {
      await this.#vault.reload(this.#db);
      throw err;
    }
    this.#ownerExists = true;
    this.#log.info('setup completed', { requestId, keyId: this.#vault.keyId });
  }

  async login(password: string, requestId: string): Promise<NewSession> {
    const owner = await this.#db.selectFrom('owner').select('password_hash').executeTakeFirst();
    if (!owner) throw new AppError('setup_required', 'Setup has not been completed.');
    if (!(await verifyPassword(password, owner.password_hash))) {
      this.#log.warn('login failed', { requestId, reason: 'bad_password' });
      throw new AppError('login_failed', 'Login failed.');
    }
    const cookieValue = randomBytes(32).toString('base64url');
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
    await this.#db
      .insertInto('sessions')
      .values({
        id_hash: sha256(cookieValue),
        handle: randomUUID(),
        created_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .execute();
    this.#log.info('login succeeded', { requestId });
    return { cookieValue, csrfToken: csrfTokenFor(cookieValue), expiresAt };
  }

  // The session behind a cookie value, or undefined if there is none or it has expired (idle 1 hour, absolute
  // 7 days). Expired sessions are deleted.
  async session(cookieValue: string): Promise<{ idHash: string; handle: string; expiresAt: Date } | undefined> {
    const idHash = sha256(cookieValue);
    const row = await this.#db.selectFrom('sessions').selectAll().where('id_hash', '=', idHash).executeTakeFirst();
    if (!row) return undefined;
    const now = this.#now().getTime();
    const lastSeen = Date.parse(row.last_seen_at);
    if (now >= Date.parse(row.expires_at) || now - lastSeen >= SESSION_IDLE_MS) {
      await this.#db.deleteFrom('sessions').where('id_hash', '=', idHash).execute();
      return undefined;
    }
    if (now - lastSeen >= TOUCH_INTERVAL_MS) {
      await this.#db
        .updateTable('sessions')
        .set({ last_seen_at: new Date(now).toISOString() })
        .where('id_hash', '=', idHash)
        .execute();
    }
    return {
      idHash,
      handle: row.handle,
      expiresAt: new Date(Math.min(Date.parse(row.expires_at), now + SESSION_IDLE_MS)),
    };
  }

  async logout(idHash: string, requestId: string): Promise<void> {
    await this.#db.deleteFrom('sessions').where('id_hash', '=', idHash).execute();
    this.#log.info('logout', { requestId });
  }
}

// The CSRF token is derived from the session cookie, so it needs no storage and cannot be computed without the
// cookie (which scripts on other sites cannot read).
export const csrfTokenFor = (cookieValue: string): string =>
  createHash('sha256').update(`csrf|${cookieValue}`).digest('base64url');
