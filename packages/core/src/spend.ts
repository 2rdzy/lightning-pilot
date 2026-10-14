import { z } from 'zod';
import { SetupLimits } from './setup.ts';
import { MsatString } from './money.ts';

export function limitsAreOrdered(
  limits: Pick<z.infer<typeof SetupLimits>, 'maxPerPayment' | 'max24h' | 'stepUpAbove'>,
): boolean {
  const { maxPerPayment, max24h, stepUpAbove } = limits;
  const cap = maxPerPayment ?? max24h;
  return (
    !(maxPerPayment !== null && max24h !== null && BigInt(maxPerPayment) > BigInt(max24h)) &&
    !(stepUpAbove !== null && cap !== null && BigInt(stepUpAbove) > BigInt(cap))
  );
}
export const SpendPolicy = SetupLimits.extend({
  maxFeeRateMode: z.enum(['refuse', 'step-up']).default('refuse'),
  maxFeeShareMode: z.enum(['refuse', 'step-up']).default('refuse'),
  maxRoutingFeeMode: z.enum(['refuse', 'step-up']).default('refuse'),
})
  .refine(limitsAreOrdered, 'The step-up threshold and per-payment limit must be within their applicable caps.')
  .meta({ id: 'SpendPolicy' });
export type SpendPolicy = z.infer<typeof SpendPolicy>;
export const SpendPolicyResponse = z
  .strictObject({
    policy: SpendPolicy.nullable(),
    usedMsat: MsatString,
    remainingMsat: MsatString.nullable(),
    scope: z.string(),
  })
  .meta({ id: 'SpendPolicyResponse' });
