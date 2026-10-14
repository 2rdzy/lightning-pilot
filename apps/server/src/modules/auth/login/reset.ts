import { writeTx, type Db } from '../../../storage/db.ts';
import type { Logger } from '../../../logging/logger.ts';

// The launcher verifies the data owner and takes the service lock before calling this offline-only operation.
export async function resetLoginThrottles(db: Db, logger: Logger): Promise<void> {
  await writeTx(db, async (trx) => {
    await trx.deleteFrom('login_throttles').execute();
  });
  logger.child('auth.login').warn('login throttles reset', { security: true });
}
