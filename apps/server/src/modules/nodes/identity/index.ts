export { runIdentityCheck, type IdentityResult } from './check.ts';
// Chain identity monitor: when the identity check runs, and the cheap comparison before a spend preview.
export {
  DEFAULT_IDENTITY_INTERVAL_MS,
  IdentityMonitor,
  identityOfRow,
  type CheckReason,
  type IdentityListener,
  type IdentityUpdate,
} from './monitor.ts';
