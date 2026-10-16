// Joins class names, skipping the empty ones (a tiny clsx; no dependency for one line).
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
