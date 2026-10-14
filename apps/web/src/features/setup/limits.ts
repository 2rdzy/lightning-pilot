import type { SetupLimits } from '@lightning-pilot/core';

// Same rule as the server: a per-payment cap above the 24-hour cap, or a step-up threshold above the cap it would
// apply under, can never take effect.
export function limitsInOrder({ maxPerPayment, max24h, stepUpAbove }: SetupLimits): boolean {
  const cap = maxPerPayment ?? max24h;
  return !(
    (maxPerPayment !== null && max24h !== null && BigInt(maxPerPayment) > BigInt(max24h)) ||
    (stepUpAbove !== null && cap !== null && BigInt(stepUpAbove) > BigInt(cap))
  );
}
