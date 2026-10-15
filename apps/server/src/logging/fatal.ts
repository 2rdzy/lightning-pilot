import type { Logger } from './logger.ts';

// Continuing after an uncaught error can leave security state inconsistent. Never let Node print raw diagnostics.
export function fatalError(
  logger: Logger,
  error: unknown,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  try {
    logger.error('uncaught error', { err: error instanceof Error ? error : new Error('unhandled rejection') });
  } catch {
    /* No logger failure may let execution continue or print raw diagnostics. */
  } finally {
    exit(1);
  }
}
