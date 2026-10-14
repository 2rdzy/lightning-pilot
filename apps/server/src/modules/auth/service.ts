// Password + TOTP authentication, setup-token issuance and server-side sessions. Login admission is bounded;
// accepted factors, device registration, counter reset and sessions commit atomically. Step-up belongs to WP08.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LoginThrottle, DEVICE_LIFETIME_MS, deviceDigest, type LoginOrigin } from './login/index.ts';
import type { LoginAttempt } from './login/throttle.ts';
import { AppError } from '@lightning-pilot/core';
import { writeTx, type Db, type RawDb } from '../../storage/db.ts';
import { hashRecoveryCode } from './totp/recovery.ts';
import { generateTotpSecret, otpauthUri } from './totp/totp.ts';
import { matchTotp } from './totp/totp.ts';
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
  raw: RawDb;
  trustedProxies?: readonly string[];
  passwordVerifier?: typeof verifyPassword;
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
  recoveryRequired: boolean;
}

export interface LoginSession extends NewSession {
  deviceCookie: string;
}

export class AuthService {
  readonly #db: Db;
  readonly #login: LoginThrottle;
  readonly #verifyPassword: typeof verifyPassword;
  readonly #vault: Vault;
  readonly #log: Logger;
  readonly #setupUrl: string;
  readonly #now: () => Date;
  #ownerExists = false;
  readonly #recovery = new Map<string, { secret: string; expires: number }>();

  private constructor(options: AuthOptions) {
    this.#db = options.db;
    this.#vault = options.vault;
    this.#log = options.logger.child('auth');
    this.#setupUrl = options.setupUrl;
    this.#now = options.now ?? (() => new Date());
    this.#verifyPassword = options.passwordVerifier ?? verifyPassword;
    this.#login = new LoginThrottle({
      db: options.db,
      raw: options.raw,
      now: this.#now,
      trustedProxies: options.trustedProxies ?? [],
      logger: this.#log,
    });
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

  setupCompleted(): void {
    this.#ownerExists = true;
  }

  async newSession(db: Db, now: Date, recoveryRequired = false): Promise<NewSession> {
    const cookieValue = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
    await db
      .insertInto('sessions')
      .values({
        id_hash: sha256(cookieValue),
        recovery_required: recoveryRequired ? 1 : 0,
        handle: randomUUID(),
        created_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .execute();
    return { cookieValue, csrfToken: csrfTokenFor(cookieValue), expiresAt, recoveryRequired };
  }

  async resetState(): Promise<void> {
    this.#ownerExists = false;
    this.#recovery.clear();
    await this.issueSetupToken();
  }

  async login(
    password: string,
    requestId: string,
    totpCode?: string,
    recoveryCode?: string,
    origin: LoginOrigin = {},
    deviceCookie?: string,
  ): Promise<LoginSession> {
    if (this.setupMode) throw new AppError('setup_required', 'Setup has not been completed.');
    return this.#login.run(origin, deviceCookie, requestId, (attempt) =>
      this.#authenticate(password, requestId, attempt, totpCode, recoveryCode),
    );
  }

  async #authenticate(
    password: string,
    requestId: string,
    attempt: LoginAttempt,
    totpCode?: string,
    recoveryCode?: string,
  ): Promise<LoginSession> {
    const owner = await this.#db.selectFrom('owner').select('password_hash').executeTakeFirstOrThrow();
    const started = performance.now();
    let matches: boolean;
    try {
      matches = await this.#verifyPassword(password, owner.password_hash);
    } finally {
      const [, log2N, r, p] = owner.password_hash.split('$');
      this.#log.info('login scrypt timing', {
        requestId,
        durationMs: Math.round(performance.now() - started),
        scrypt: { log2N: Number(log2N), r: Number(r), p: Number(p) },
      });
    }
    this.#login.assertOpen();
    if (!matches) throw new AppError('login_failed', 'Login failed.');
    return writeTx(this.#db, async (trx) => {
      const now = this.#now();
      let recoveryRequired = false;
      // From here the password is known to be right: a refusal also counts on the account's factor counter.
      const factorFailed = (factor: 'totp' | 'recovery') => {
        attempt.failedFactor = factor;
        return new AppError('login_failed', 'Login failed.');
      };
      if (recoveryCode) {
        if (totpCode) throw factorFailed('recovery');
        let hash;
        try {
          hash = hashRecoveryCode(recoveryCode);
        } catch {
          throw factorFailed('recovery');
        }
        const code = await trx
          .selectFrom('recovery_codes')
          .selectAll()
          .where('code_hash', '=', hash)
          .where('used_at', 'is', null)
          .executeTakeFirst();
        if (!code) throw factorFailed('recovery');
        await trx
          .updateTable('recovery_codes')
          .set({ used_at: now.toISOString() })
          .where('code_hash', '=', hash)
          .execute();
        recoveryRequired = true;
      } else {
        const factor = await trx.selectFrom('auth_totp').selectAll().executeTakeFirst();
        const counter =
          factor && totpCode
            ? matchTotp(this.#vault.openSecret(factor, 'totp'), totpCode, now, BigInt(factor.last_counter))
            : undefined;
        if (counter === undefined) throw factorFailed('totp');
        await trx.updateTable('auth_totp').set({ last_counter: counter.toString() }).where('id', '=', 1).execute();
      }
      const session = await this.newSession(trx, now, recoveryRequired);
      const hash = deviceDigest(attempt.deviceCookie);
      // Revocation or expiry during the hash must not resurrect an old cookie. Register a fresh device instead.
      const existing = hash
        ? await trx
            .selectFrom('known_devices')
            .select('id_hash')
            .where('id_hash', '=', hash)
            .where('expires_at', '>', now.toISOString())
            .where('last_seen_at', '>', new Date(now.getTime() - DEVICE_LIFETIME_MS).toISOString())
            .executeTakeFirst()
        : undefined;
      const deviceCookie =
        existing && attempt.deviceCookie ? attempt.deviceCookie : randomBytes(32).toString('base64url');
      const deviceHash = sha256(deviceCookie);
      const dates = {
        last_seen_at: now.toISOString(),
        expires_at: new Date(now.getTime() + DEVICE_LIFETIME_MS).toISOString(),
      };
      if (existing) await trx.updateTable('known_devices').set(dates).where('id_hash', '=', deviceHash).execute();
      else
        await trx
          .insertInto('known_devices')
          .values({ id_hash: deviceHash, created_at: now.toISOString(), ...dates, source: attempt.source.descriptor })
          .execute();
      await this.#login.succeeded(trx, attempt.source);
      if (recoveryRequired) this.#log.warn('recovery code used', { requestId, security: true });
      return { ...session, deviceCookie };
    });
  }

  // The session behind a cookie value, or undefined if there is none or it has expired (idle 1 hour, absolute
  // 7 days). Expired sessions are deleted.
  async session(
    cookieValue: string,
  ): Promise<{ idHash: string; handle: string; expiresAt: Date; recoveryRequired: boolean } | undefined> {
    const idHash = sha256(cookieValue);
    const row = await this.#db.selectFrom('sessions').selectAll().where('id_hash', '=', idHash).executeTakeFirst();
    if (!row) return undefined;
    const now = this.#now().getTime();
    const lastSeen = Date.parse(row.last_seen_at);
    if (now >= Date.parse(row.expires_at) || now - lastSeen >= SESSION_IDLE_MS) {
      await this.#db.deleteFrom('sessions').where('id_hash', '=', idHash).execute();
      this.#recovery.delete(idHash);
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
      recoveryRequired: row.recovery_required === 1,
      handle: row.handle,
      expiresAt: new Date(Math.min(Date.parse(row.expires_at), now + SESSION_IDLE_MS)),
    };
  }

  // Throttled setup-token check: verify returns the matched token row, or undefined for a wrong token.
  setupAttempt<T>(origin: LoginOrigin, requestId: string, verify: () => Promise<T | undefined>): Promise<T> {
    return this.#login.setup(origin, requestId, verify);
  }

  async beginRecovery(idHash: string): Promise<{ secret: string; uri: string }> {
    const row = await this.#db
      .selectFrom('sessions')
      .select('recovery_required')
      .where('id_hash', '=', idHash)
      .executeTakeFirst();
    if (row?.recovery_required !== 1)
      throw new AppError('step_up_required', 'Use a recovery login before enrolling a new authenticator.');
    const now = this.#now().getTime();
    for (const [id, pending] of this.#recovery) if (pending.expires <= now) this.#recovery.delete(id);
    const existing = this.#recovery.get(idHash);
    if (existing) return { secret: existing.secret, uri: otpauthUri(existing.secret, 'owner') };
    const secret = generateTotpSecret();
    this.#recovery.set(idHash, { secret, expires: this.#now().getTime() + 15 * 60_000 });
    return { secret, uri: otpauthUri(secret, 'owner') };
  }

  // The session gains every permission here, so it gets a new id (its internal handle stays, as at step-up).
  async finishRecovery(
    idHash: string,
    code: string,
    requestId: string,
  ): Promise<{ cookieValue: string; expiresAt: Date }> {
    const pending = this.#recovery.get(idHash);
    const counter =
      pending && pending.expires > this.#now().getTime() ? matchTotp(pending.secret, code, this.#now()) : undefined;
    if (counter === undefined || !pending) throw new AppError('validation_failed', 'The enrolment code is not valid.');
    const rotated = await writeTx(this.#db, async (trx) => {
      if (this.#recovery.get(idHash) !== pending || pending.expires <= this.#now().getTime())
        throw new AppError('validation_failed', 'The enrolment expired. Start again.');
      const row = await trx
        .selectFrom('sessions')
        .select('recovery_required')
        .where('id_hash', '=', idHash)
        .executeTakeFirst();
      if (row?.recovery_required !== 1)
        throw new AppError('step_up_required', 'Use a recovery login before enrolling a new authenticator.');
      await trx
        .updateTable('auth_totp')
        .set({ ...this.#vault.sealSecret(pending.secret, 'totp'), last_counter: counter.toString() })
        .where('id', '=', 1)
        .execute();
      await trx.deleteFrom('sessions').where('id_hash', '!=', idHash).execute();
      const cookieValue = randomBytes(32).toString('base64url');
      const updated = await trx
        .updateTable('sessions')
        .set({ recovery_required: 0, id_hash: sha256(cookieValue) })
        .where('id_hash', '=', idHash)
        .returning('expires_at')
        .executeTakeFirstOrThrow();
      return { cookieValue, expiresAt: new Date(updated.expires_at) };
    });
    this.#recovery.clear();
    this.#log.warn('authenticator recovered', { requestId, security: true });
    return rotated;
  }

  close(): Promise<void> {
    this.#recovery.clear();
    return this.#login.close();
  }

  async logout(idHash: string, requestId: string): Promise<void> {
    await this.#db.deleteFrom('sessions').where('id_hash', '=', idHash).execute();
    this.#recovery.delete(idHash);
    this.#log.info('logout', { requestId });
  }
}

// The CSRF token is derived from the session cookie, so it needs no storage and cannot be computed without the
// cookie (which scripts on other sites cannot read).
export const csrfTokenFor = (cookieValue: string): string =>
  createHash('sha256').update(`csrf|${cookieValue}`).digest('base64url');
