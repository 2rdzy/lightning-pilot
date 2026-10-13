// Number and date formatting from the browser's region (style guide §6a). Amounts stay bigint msat throughout: Intl
// formats bigint values exactly, and only the separators come from Intl; the arithmetic is integer division.
import type { Chain } from '@lightning-pilot/core';

// The region to format with: the first of the browser's languages, or a chosen one (Settings › Display, later).
export function browserLocale(languages: readonly string[] | undefined, fallback = 'en-US'): string {
  for (const tag of languages ?? []) {
    try {
      return Intl.getCanonicalLocales(tag)[0] ?? fallback;
    } catch {
      // A malformed tag from the browser: try the next one.
    }
  }
  return fallback;
}

const integerFormats = new Map<string, Intl.NumberFormat>();
function integerFormat(locale: string): Intl.NumberFormat {
  let format = integerFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: true });
    integerFormats.set(locale, format);
  }
  return format;
}

export function decimalSeparator(locale: string): string {
  return new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';
}

// A count, height or other whole number, grouped as the region does.
export function formatInteger(value: bigint | number, locale: string): string {
  return integerFormat(locale).format(value);
}

// Whole sats, rounded down: a spendable amount is never shown larger than it is.
export function formatSats(msat: bigint, locale: string): string {
  return integerFormat(locale).format(msat / 1000n);
}

// A cost (an amount to pay, a fee, a total): exact to the msat when it is not a whole sat, never rounded, so what
// is paid is never shown smaller than it is ("1,234.567"). Balances use formatSats instead.
export function formatCost(msat: bigint, locale: string): string {
  return formatExactSats(msat, locale) ?? formatSats(msat, locale);
}

// The exact amount when it is not a whole number of sats ("1,234.567 sat" on hover); undefined otherwise.
export function formatExactSats(msat: bigint, locale: string): string | undefined {
  const rest = msat % 1000n;
  if (rest === 0n) return undefined;
  return `${integerFormat(locale).format(msat / 1000n)}${decimalSeparator(locale)}${rest.toString().padStart(3, '0')}`;
}

// Whole coins with 8 decimals (1 coin = 100 000 000 sat), rounded down to the sat.
export function formatCoins(msat: bigint, locale: string): string {
  const sats = msat / 1000n;
  const whole = sats / 100_000_000n;
  const fraction = (sats % 100_000_000n).toString().padStart(8, '0');
  return `${integerFormat(locale).format(whole)}${decimalSeparator(locale)}${fraction}`;
}

// The coin of each chain profile (style guide §2): XBT on Bitcoin BLAKE2b, BTC on Bitcoin (SHA256d).
export const COIN: Record<Chain, string> = { blake2b: 'XBT', bitcoin: 'BTC' };

// A sats field accepts digits only; grouping characters the region uses (and spaces) are ignored. Returns msat, or
// undefined when the text is not a whole number of sats.
export function parseSatsInput(text: string, locale: string): bigint | undefined {
  const group = new Intl.NumberFormat(locale).formatToParts(1_000_000).find((p) => p.type === 'group')?.value;
  let cleaned = text.replace(/[\s\u00a0\u202f]/g, '');
  if (group) cleaned = cleaned.split(group).join('');
  if (!/^[0-9]{1,16}$/.test(cleaned)) return undefined;
  return BigInt(cleaned) * 1000n;
}

export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

// Ids and keys: first 8 and last 8 characters (style guide §6).
export function shortId(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}
