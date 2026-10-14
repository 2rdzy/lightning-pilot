// auth module: setup token, owner password, sessions, and the guard enforcing every route's permission.
export { authRoutes, createGuard, readSessionCookie, SESSION_COOKIE } from './routes.ts';
export { AuthService, csrfTokenFor, DEFAULT_SCRYPT, hashPassword, verifyPassword, type ScryptCost } from './service.ts';
export type { LoginOrigin } from './login/index.ts';
export { resetLoginThrottles } from './login/reset.ts';
