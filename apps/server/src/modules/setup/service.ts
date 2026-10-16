// Drafts live only in memory; the verified owner, factors, optional node and choices commit together.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  limitsAreOrdered,
  AppError,
  AdapterError,
  SetupLimits as LimitsSchema,
  type SetupAction,
  type SetupProgress,
  type SetupLimits,
  type SetupAlerts,
} from '@lightning-pilot/core';
import { writeTx, type Db } from '../../storage/db.ts';
import type { Logger } from '../../logging/logger.ts';
import { hashPassword, type AuthService, type LoginOrigin, type ScryptCost } from '../auth/index.ts';
import { generateTotpSecret, matchTotp, otpauthUri } from '../auth/totp/totp.ts';
import { generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode } from '../auth/totp/recovery.ts';
import { verifyRunes } from '../nodes/credentials.ts';
import type { NodesService, PreparedNode } from '../nodes/service.ts';
import type { Vault } from '../vault/index.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const normalise = (token: string) => token.toUpperCase().replace(/[^A-Z0-9]/g, '');
const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const IDLE_MS = 15 * 60_000;
const DEVICE_MS = 365 * 24 * 60 * 60_000;

// A per-payment cap above the 24-hour cap, or a step-up threshold above the cap it would apply under, can never
// take effect: refuse it rather than store something the owner did not mean.
export function limitsInOrder(limits: SetupLimits): void {
  if (!limitsAreOrdered(limits))
    throw new AppError(
      'validation_failed',
      'The step-up threshold must not exceed the per-payment limit, which must not exceed the 24-hour limit.',
    );
}

interface Draft {
  cookie: string;
  tokenHash: string;
  csrfToken: string;
  expiresAt: number;
  touched: number;
  step: SetupProgress['step'];
  passwordHash: string;
  secret: string;
  counter: bigint;
  recoveryHashes: string[];
  node?: PreparedNode;
  limits?: SetupLimits;
  alerts: SetupAlerts;
  failures: number;
  retryAt: number;
}
export interface SetupOptions {
  db: Db;
  vault: Vault;
  auth: AuthService;
  nodes: NodesService;
  logger: Logger;
  tlsCertificate?: SetupProgress['tlsCertificate'];
  scryptCost?: ScryptCost;
  now?: () => Date;
}
export interface SetupReply {
  progress: SetupProgress;
  cookie?: string;
  sessionCookie?: string;
  deviceCookie?: string;
}
export class SetupService {
  readonly #options: SetupOptions;
  readonly #now: () => Date;
  #draft: Draft | undefined;
  #busy = false;
  constructor(options: SetupOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }
  #progress(d: Draft, extra: Partial<SetupProgress> = {}): SetupProgress {
    return {
      step: d.step,
      csrfToken: d.csrfToken,
      expiresAt: new Date(Math.min(d.expiresAt, d.touched + IDLE_MS)).toISOString(),
      vaultKeyId: this.#options.vault.keyId,
      ...(this.#options.tlsCertificate ? { tlsCertificate: this.#options.tlsCertificate } : {}),
      ...extra,
    };
  }
  #current(cookie: string | undefined, csrf: string | undefined): Draft {
    const d = this.#draft;
    const now = this.#now().getTime();
    if (!d || now >= d.expiresAt || now >= d.touched + IDLE_MS || !cookie || !equal(sha(cookie), sha(d.cookie))) {
      if (d && (now >= d.expiresAt || now >= d.touched + IDLE_MS)) this.#draft = undefined;
      throw new AppError('setup_token_invalid', 'The setup session expired. Start setup again.');
    }
    if (!csrf || !equal(csrf, d.csrfToken)) throw new AppError('csrf_failed', 'Missing or wrong CSRF token.');
    d.touched = now;
    return d;
  }
  #delay(next: number): never {
    throw new AppError('too_early', 'Wait before trying again.', {
      retryAfter: Math.max(1, Math.ceil((next - this.#now().getTime()) / 1000)),
    });
  }
  async act(
    action: SetupAction,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
    origin: LoginOrigin = {},
  ): Promise<SetupReply> {
    if (!this.#options.auth.setupMode) throw new AppError('not_found', 'Not found.');
    if (this.#busy) throw new AppError('busy', 'A setup step is already running. Try again.');
    this.#busy = true;
    try {
      if (action.action === 'start') return await this.#start(action.token, cookie, origin, requestId);
      const d = this.#current(cookie, csrf);
      if (action.action === 'cancel') {
        this.#draft = undefined;
        return { progress: this.#progress({ ...d, step: 'cancelled' }) };
      }
      if (action.action !== d.step)
        throw new AppError('validation_failed', 'Complete the current setup step first.', { step: d.step });
      const { db, vault, auth, nodes } = this.#options;
      switch (action.action) {
        case 'password': {
          d.passwordHash = await hashPassword(action.password, this.#options.scryptCost);
          d.secret = generateTotpSecret();
          d.step = 'totp';
          return {
            progress: this.#progress(d, { secret: d.secret, uri: otpauthUri(d.secret, 'owner') }),
            cookie: d.cookie,
          };
        }
        case 'totp': {
          if (d.retryAt > this.#now().getTime()) this.#delay(d.retryAt);
          const counter = matchTotp(d.secret, action.code, this.#now());
          if (counter === undefined) {
            d.failures++;
            d.retryAt = this.#now().getTime() + Math.min(2 ** (d.failures - 1), 900) * 1000;
            throw new AppError('validation_failed', 'The authenticator code is not valid.');
          }
          d.counter = counter;
          const codes = generateRecoveryCodes();
          d.recoveryHashes = codes.map(hashRecoveryCode);
          d.step = 'recovery';
          return { progress: this.#progress(d, { recoveryCodes: codes }), cookie: d.cookie };
        }
        case 'recovery':
          if (!d.recoveryHashes.some((h) => verifyRecoveryCode(action.code, h)))
            throw new AppError('validation_failed', 'Type one of the recovery codes you saved.');
          d.step = 'backup';
          break;
        case 'backup':
          d.step = 'node';
          break;
        case 'node': {
          if (action.node === null) {
            delete d.node;
            d.step = 'alerts';
            break;
          }
          const prepared = await nodes.prepare(action.node, requestId);
          await this.#checkCredential(prepared);
          let fees;
          try {
            fees = await prepared.adapter.chain.getFeeEstimates();
          } catch (err) {
            if (
              !(err instanceof AdapterError) ||
              !['node_credential_revoked', 'permission_denied', 'capability_missing'].includes(err.code)
            )
              throw err;
            d.node = prepared;
            d.step = 'limits';
            delete d.limits;
            return {
              progress: this.#progress(d, { nodeIdentity: nodes.identity(prepared.row), feeEstimateAvailable: false }),
              cookie: d.cookie,
            };
          }
          const urgent = fees.rates.fastest;
          const rateParts = urgent.split('.');
          const scaled = BigInt(rateParts[0] ?? '0') * 1000n + BigInt((rateParts[1] ?? '').padEnd(3, '0').slice(0, 3));
          const cap = scaled * 3n;
          const defaults: SetupLimits = {
            maxPerPayment: null,
            max24h: null,
            stepUpAbove: null,
            maxFeeRate: `${cap / 1000n}.${(cap % 1000n).toString().padStart(3, '0')}`,
            maxFeeSharePercent: 5,
            maxRoutingFeeSharePercent: 1,
            routingFeeAllowance: '10',
          };
          if (!LimitsSchema.safeParse(defaults).success)
            throw new AppError(
              'node_bad_response',
              'The node fee estimate cannot be used. Enter the node again after checking its fee estimate.',
            );
          d.node = prepared;
          d.step = 'limits';
          d.limits = defaults;
          return {
            progress: this.#progress(d, {
              nodeIdentity: nodes.identity(prepared.row),
              defaultLimits: defaults,
              feeEstimateAvailable: true,
            }),
            cookie: d.cookie,
          };
        }
        case 'limits':
          limitsInOrder(action.limits);
          d.limits = action.limits;
          d.step = 'alerts';
          break;
        case 'alerts':
          d.alerts = action.alerts;
          d.step = 'complete';
          break;
        case 'complete': {
          // Recheck node/credentials before locking the database; a draft is not an admission indefinitely.
          if (d.node) {
            d.node = await nodes.prepare(d.node.input, requestId);
            await this.#checkCredential(d.node);
          }
          const now = this.#now();
          const deviceCookie = randomBytes(32).toString('base64url');
          let newSession;
          try {
            newSession = await writeTx(db, async (trx) => {
              const token = await trx.selectFrom('setup_token').selectAll().executeTakeFirst();
              if (
                !token ||
                token.token_hash !== d.tokenHash ||
                Date.parse(token.expires_at) <= now.getTime() ||
                now.getTime() >= d.expiresAt ||
                now.getTime() >= d.touched + IDLE_MS
              )
                throw new AppError('setup_token_invalid', 'The setup token is not valid.');
              if (await trx.selectFrom('owner').select('id').executeTakeFirst())
                throw new AppError('not_found', 'Not found.');
              if (!vault.initialised) await vault.initialise(trx);
              await trx
                .insertInto('owner')
                .values({ id: 1, password_hash: d.passwordHash, created_at: now.toISOString() })
                .execute();
              await trx
                .insertInto('auth_totp')
                .values({ id: 1, ...vault.sealSecret(d.secret, 'totp'), last_counter: d.counter.toString() })
                .execute();
              await trx
                .insertInto('recovery_codes')
                .values(d.recoveryHashes.map((code_hash) => ({ code_hash, used_at: null })))
                .execute();
              if (d.node) {
                await nodes.storePrepared(trx, d.node);
                const l = d.limits;
                if (!l) throw new AppError('internal', 'Setup limits are missing.');
                await trx
                  .insertInto('spend_limits')
                  .values({
                    chain: d.node.row.chain,
                    pubkey: d.node.row.pubkey,
                    max_per_payment_sat: l.maxPerPayment,
                    max_24h_sat: l.max24h,
                    step_up_above_sat: l.stepUpAbove,
                    max_fee_rate_mode: l.maxFeeRateMode ?? 'refuse',
                    max_fee_share_mode: l.maxFeeShareMode ?? 'refuse',
                    max_routing_fee_mode: l.maxRoutingFeeMode ?? 'refuse',
                    max_fee_rate: l.maxFeeRate,
                    max_fee_share_percent: l.maxFeeSharePercent,
                    max_routing_fee_share_percent: l.maxRoutingFeeSharePercent,
                    routing_fee_allowance_sat: l.routingFeeAllowance,
                  })
                  .onConflict((oc) => oc.columns(['chain', 'pubkey']).doNothing())
                  .execute();
              }
              let alerts: unknown = { ...d.alerts, pending: d.alerts.kind !== 'none' };
              if (d.alerts.kind === 'telegram') {
                const sealed = vault.sealSecret(d.alerts.botToken, 'telegram_token');
                alerts = {
                  kind: 'telegram',
                  pending: true,
                  key_id: sealed.key_id,
                  nonce: sealed.nonce.toString('base64'),
                  ciphertext: sealed.ciphertext.toString('base64'),
                };
              }
              await trx
                .insertInto('settings')
                .values({ key: 'setup_alerts', value: JSON.stringify(alerts) })
                .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(alerts) }))
                .execute();
              await trx
                .insertInto('known_devices')
                .values({
                  id_hash: sha(deviceCookie),
                  created_at: now.toISOString(),
                  last_seen_at: now.toISOString(),
                  expires_at: new Date(now.getTime() + DEVICE_MS).toISOString(),
                })
                .execute();
              const session = await auth.newSession(trx, now);
              await trx.deleteFrom('setup_token').execute();
              return session;
            });
          } catch (err) {
            await vault.reload(db);
            throw err;
          }
          auth.setupCompleted();
          if (d.node) nodes.rememberPrepared(d.node, requestId);
          this.#draft = undefined;
          this.#options.logger.child('setup').info('setup completed', {
            requestId,
            security: true,
            source: origin.peerAddress ?? 'unknown',
            deviceId: sha(deviceCookie),
            keyId: vault.keyId,
            alerts: d.alerts.kind,
          });
          return {
            progress: this.#progress(
              { ...d, step: 'done' },
              { session: { csrfToken: newSession.csrfToken, expiresAt: newSession.expiresAt.toISOString() } },
            ),
            sessionCookie: newSession.cookieValue,
            deviceCookie,
          };
        }
      }
      return { progress: this.#progress(d), cookie: d.cookie };
    } finally {
      this.#busy = false;
    }
  }
  async #start(token: string, cookie: string | undefined, origin: LoginOrigin, requestId: string): Promise<SetupReply> {
    const now = this.#now().getTime();
    const row = await this.#options.auth.setupAttempt(origin, requestId, async () => {
      const stored = await this.#options.db.selectFrom('setup_token').selectAll().executeTakeFirst();
      return stored && Date.parse(stored.expires_at) > now && equal(sha(normalise(token)), stored.token_hash)
        ? stored
        : undefined;
    });
    const existing = this.#draft;
    if (existing && now < existing.expiresAt && now < existing.touched + IDLE_MS) {
      if (!cookie || !equal(sha(cookie), sha(existing.cookie)))
        throw new AppError('busy', 'Setup is already open in another browser.');
      existing.touched = now;
      return { progress: this.#progress(existing), cookie: existing.cookie };
    }
    const d: Draft = {
      cookie: randomBytes(32).toString('base64url'),
      tokenHash: row.token_hash,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: Date.parse(row.expires_at),
      touched: now,
      step: 'password',
      passwordHash: '',
      secret: '',
      counter: -1n,
      recoveryHashes: [],
      alerts: { kind: 'none' },
      failures: 0,
      retryAt: 0,
    };
    this.#draft = d;
    return { progress: this.#progress(d), cookie: d.cookie };
  }
  async #checkCredential(node: PreparedNode): Promise<void> {
    const status = await node.adapter.node.getStatus();
    await verifyRunes(
      node.adapter,
      node.input.viewRune ?? '',
      node.input.spendRune,
      node.input.spendRune === undefined ? 'read-only' : 'standard',
    );
    if (!status.reachable || (node.input.spendRune && status.credential === 'revoked'))
      throw new AppError('node_credential_revoked', 'The node credential did not pass its check.');
    if (status.accessLevel === 'admin' || status.accessLevel === 'full')
      throw new AppError('permission_denied', 'Setup accepts restricted read-only or standard credentials.');
  }

  close(): void {
    this.#draft = undefined;
  }
}
