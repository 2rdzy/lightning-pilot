// Password + TOTP authentication, setup-token issuance and server-side sessions. Login admission is bounded;
// accepted factors, device registration, counter reset and sessions commit atomically. Step-up belongs to WP08.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LoginThrottle, DEVICE_LIFETIME_MS, deviceDigest, type LoginOrigin } from './login/index.ts';
import type { LoginAttempt } from './login/throttle.ts';
import { AppError, type StepUpStrength } from '@lightning-pilot/core';
import { SessionsService, publicSource, type NewSession } from '../sessions/index.ts';
export { csrfTokenFor, type NewSession } from '../sessions/index.ts';
import { writeTx, type Db, type RawDb } from '../../storage/db.ts';
import { generateRecoveryCodes, hashRecoveryCode } from './totp/recovery.ts';
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
  sessionIdleMs?: number;
  sessionAbsoluteMs?: number;
}

export interface LoginSession extends NewSession {
  deviceCookie: string;
}

export class AuthService {
  readonly sessions: SessionsService;
  readonly #db: Db;
  readonly #login: LoginThrottle;
  readonly #verifyPassword: typeof verifyPassword;
  readonly #vault: Vault;
  readonly #log: Logger;
  readonly #setupUrl: string;
  readonly #now: () => Date;
  #ownerExists = false;
  readonly #recovery = new Map<string, { secret: string; expires: number; handle: string }>();
  readonly #changes = new Map<string, { secret: string; expires: number; passwordHash: string }>();

  private constructor(options: AuthOptions) {
    this.#db = options.db;
    this.#vault = options.vault;
    this.#log = options.logger.child('auth');
    this.#setupUrl = options.setupUrl;
    this.#now = options.now ?? (() => new Date());
    this.#verifyPassword = options.passwordVerifier ?? verifyPassword;
    this.sessions = new SessionsService({
      db: options.db,
      logger: options.logger,
      now: this.#now,
      ...(options.sessionIdleMs === undefined ? {} : { idleMs: options.sessionIdleMs }),
      ...(options.sessionAbsoluteMs === undefined ? {} : { absoluteMs: options.sessionAbsoluteMs }),
    });
    this.sessions.onEnd((handle) => {
      for (const [id, pending] of this.#recovery) if (pending.handle === handle) this.#recovery.delete(id);
      this.#changes.delete(handle);
    });
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
    await service.sessions.loadPolicy();
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

  newSession(db: Db, now: Date, recoveryRequired = false, source = 'setup'): Promise<NewSession> {
    return this.sessions.create(db, now, recoveryRequired, source);
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
      const session = await this.newSession(trx, now, recoveryRequired, publicSource(attempt.source.descriptor));
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
          .values({
            id_hash: deviceHash,
            created_at: now.toISOString(),
            ...dates,
            source: publicSource(attempt.source.descriptor),
          })
          .execute();
      await this.#login.succeeded(trx, attempt.source);
      if (recoveryRequired) this.#log.warn('recovery code used', { requestId, security: true });
      return { ...session, deviceCookie };
    });
  }

  session(cookie: string, activity = false) {
    return this.sessions.session(cookie, activity);
  }

  // Throttled setup-token check: verify returns the matched token row, or undefined for a wrong token.
  setupAttempt<T>(origin: LoginOrigin, requestId: string, verify: () => Promise<T | undefined>): Promise<T> {
    return this.#login.setup(origin, requestId, verify);
  }

  async beginRecovery(idHash: string): Promise<{ secret: string; uri: string }> {
    const row = await this.sessions.live(this.#db, idHash);
    if (row.recovery_required !== 1)
      throw new AppError('step_up_required', 'Use a recovery login before enrolling a new authenticator.');
    const now = this.#now().getTime();
    for (const [id, pending] of this.#recovery) if (pending.expires <= now) this.#recovery.delete(id);
    const existing = this.#recovery.get(idHash);
    if (existing) return { secret: existing.secret, uri: otpauthUri(existing.secret, 'owner') };
    const secret = generateTotpSecret();
    this.#recovery.set(idHash, { secret, expires: this.#now().getTime() + 15 * 60_000, handle: row.handle });
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
      const row = await this.sessions.live(trx, idHash);
      if (row.recovery_required !== 1)
        throw new AppError('step_up_required', 'Use a recovery login before enrolling a new authenticator.');
      await trx
        .updateTable('auth_totp')
        .set({ ...this.#vault.sealSecret(pending.secret, 'totp'), last_counter: counter.toString() })
        .where('id', '=', 1)
        .execute();
      const others = await trx
        .selectFrom('sessions')
        .select('handle')
        .where('id_hash', '!=', idHash)
        .where('ended_at', 'is', null)
        .execute();
      await this.sessions.markEnded(
        trx,
        others.map((r) => r.handle),
        'recovery',
      );
      const cookieValue = randomBytes(32).toString('base64url');
      const updated = await trx
        .updateTable('sessions')
        .set({ recovery_required: 0, id_hash: sha256(cookieValue) })
        .where('id_hash', '=', idHash)
        .returning('expires_at')
        .executeTakeFirstOrThrow();
      return {
        cookieValue,
        expiresAt: new Date(updated.expires_at),
        ended: others.map((r) => r.handle),
        handle: row.handle,
      };
    });
    this.sessions.notifyEnded(rotated.ended, 'recovery');
    this.sessions.clearGrants(rotated.handle);
    this.#recovery.clear();
    this.#log.warn('authenticator recovered', { requestId, security: true });
    return rotated;
  }

  async close(): Promise<void> {
    this.#recovery.clear();
    this.#changes.clear();
    await this.sessions.close();
    await this.#login.close();
  }

  async logout(idHash: string, requestId: string): Promise<void> {
    const row = await this.sessions.live(this.#db, idHash);
    await this.sessions.end(row.handle, 'logout');
    this.#log.info('logout', { requestId });
  }

  stepUp(idHash: string, password: string, strength: StepUpStrength, totpCode: string | undefined, requestId: string) {
    return this.sessions.stepUp(
      idHash,
      strength,
      requestId,
      async () => {
        const owner = await this.#db.selectFrom('owner').select('password_hash').executeTakeFirstOrThrow();
        return { matches: await this.#verifyPassword(password, owner.password_hash), snapshot: owner.password_hash };
      },
      async (db, snapshot) => {
        const owner = await db.selectFrom('owner').select('password_hash').executeTakeFirst();
        if (owner?.password_hash !== snapshot) return false;
        if (strength === 'password') return true;
        const factor = await db.selectFrom('auth_totp').selectAll().executeTakeFirst();
        const counter =
          factor && totpCode
            ? matchTotp(this.#vault.openSecret(factor, 'totp'), totpCode, this.#now(), BigInt(factor.last_counter))
            : undefined;
        if (counter === undefined) return false;
        await db.updateTable('auth_totp').set({ last_counter: counter.toString() }).where('id', '=', 1).execute();
        return true;
      },
    );
  }

  async requireStepUp(idHash: string, strength: StepUpStrength, db: Db = this.#db): Promise<void> {
    const row = await this.sessions.live(db, idHash);
    this.sessions.requireGrant(row, strength);
  }

  async devices(idHash: string) {
    return this.sessions.authorized(idHash, 'security', async (db) => {
      const now = this.#now().toISOString();
      const rows = await db
        .selectFrom('known_devices')
        .selectAll()
        .where('expires_at', '>', now)
        .where('last_seen_at', '>', new Date(this.#now().getTime() - DEVICE_LIFETIME_MS).toISOString())
        .execute();
      return {
        items: rows.map((r) => ({
          id: r.handle,
          createdAt: r.created_at,
          lastUsedAt: r.last_seen_at,
          expiresAt: r.expires_at,
          source: publicSource(r.source),
        })),
      };
    });
  }

  async revokeDevice(idHash: string, handle: string, requestId: string): Promise<void> {
    await this.sessions.authorized(idHash, 'security', async (db) => {
      await db.deleteFrom('known_devices').where('handle', '=', handle).execute();
    });
    this.#log.info('known device revoked', { requestId, security: true });
  }

  async recoveryCount(idHash: string) {
    return this.sessions.authorized(idHash, 'security', async (db) => ({
      remaining: (await db.selectFrom('recovery_codes').select('code_hash').where('used_at', 'is', null).execute())
        .length,
    }));
  }

  async regenerateRecoveryCodes(idHash: string, requestId: string) {
    const codes = generateRecoveryCodes();
    await this.sessions.authorized(idHash, 'security', async (db) => {
      await db.deleteFrom('recovery_codes').execute();
      await db
        .insertInto('recovery_codes')
        .values(codes.map((code) => ({ code_hash: hashRecoveryCode(code), used_at: null })))
        .execute();
    });
    this.#log.warn('recovery codes regenerated', { requestId, security: true });
    return { codes };
  }

  async #securityChange(
    idHash: string,
    requestId: string,
    change: (db: Db, handle: string) => Promise<void>,
  ): Promise<void> {
    const result = await this.sessions.authorized(idHash, 'security', async (db, row) => {
      await change(db, row.handle);
      const others = await db
        .selectFrom('sessions')
        .select('handle')
        .where('handle', '!=', row.handle)
        .where('ended_at', 'is', null)
        .execute();
      const ended = others.map((r) => r.handle);
      await this.sessions.markEnded(db, ended, 'security_change');
      this.sessions.clearGrants(row.handle);
      return { ended, handle: row.handle };
    });
    this.sessions.notifyEnded(result.ended, 'security_change');
    this.sessions.clearGrants(result.handle);
    this.#changes.delete(result.handle);
    this.#log.warn('authentication settings changed', { requestId, security: true });
  }

  async changePassword(idHash: string, password: string, requestId: string): Promise<void> {
    return this.sessions.passwordWork(async () => {
      const snapshot = await this.sessions.authorized(
        idHash,
        'security',
        async (db) => (await db.selectFrom('owner').select('password_hash').executeTakeFirstOrThrow()).password_hash,
      );
      // Password generation uses the owner's existing measured cost, not the development/test default.
      const [, log2N, r, p] = snapshot.split('$');
      const hash = await hashPassword(password, { log2N: Number(log2N), r: Number(r), p: Number(p) });
      await this.#securityChange(idHash, requestId, async (db) => {
        const owner = await db.selectFrom('owner').select('password_hash').executeTakeFirstOrThrow();
        if (owner.password_hash !== snapshot)
          throw new AppError('step_up_required', 'Authentication settings changed.');
        await db.updateTable('owner').set({ password_hash: hash }).where('id', '=', 1).execute();
      });
    });
  }

  async beginTotpChange(idHash: string) {
    const row = await this.sessions.authorized(idHash, 'security', async (db, row) => ({
      handle: row.handle,
      passwordHash: (await db.selectFrom('owner').select('password_hash').executeTakeFirstOrThrow()).password_hash,
    }));
    const now = this.#now().getTime();
    for (const [id, pending] of this.#changes) if (pending.expires <= now) this.#changes.delete(id);
    let pending = this.#changes.get(row.handle);
    if (!pending) {
      if (this.#changes.size >= 10)
        throw new AppError('busy', 'Too many pending authenticator changes.', { retryAfter: 1 });
      pending = { secret: generateTotpSecret(), expires: now + 15 * 60_000, passwordHash: row.passwordHash };
      this.#changes.set(row.handle, pending);
    }
    return {
      secret: pending.secret,
      uri: otpauthUri(pending.secret, 'owner'),
      expiresAt: new Date(pending.expires).toISOString(),
    };
  }

  async finishTotpChange(idHash: string, code: string, requestId: string): Promise<void> {
    await this.#securityChange(idHash, requestId, async (db, handle) => {
      const pending = this.#changes.get(handle);
      const owner = await db.selectFrom('owner').select('password_hash').executeTakeFirstOrThrow();
      const counter =
        pending && pending.expires > this.#now().getTime() && owner.password_hash === pending.passwordHash
          ? matchTotp(pending.secret, code, this.#now())
          : undefined;
      if (!pending || counter === undefined)
        throw new AppError('validation_failed', 'The enrolment code is not valid.');
      await db
        .updateTable('auth_totp')
        .set({ ...this.#vault.sealSecret(pending.secret, 'totp'), last_counter: counter.toString() })
        .where('id', '=', 1)
        .execute();
    });
  }
}
