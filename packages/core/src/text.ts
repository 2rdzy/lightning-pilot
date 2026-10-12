// Untrusted text: aliases, descriptions and labels that come from a node or a peer. They are shown escaped (React
// does that) and never interpreted as HTML or URLs; here they are length-limited and stripped of control and
// bidirectional formatting characters, which can make text display differently from what it is.
import { z } from 'zod';

declare const untrusted: unique symbol;
export type UntrustedText = string & { readonly [untrusted]: true };

// C0/C1 controls (keeping tab and newline), bidi embeddings/overrides/isolates and the directional marks.
// Built from a string of escapes so the source itself stays plain ASCII.
const UNSAFE = new RegExp(
  // eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern
  '[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);

export const UNTRUSTED_TEXT_MAX = 640;

export function untrustedText(value: string, maxLength = UNTRUSTED_TEXT_MAX): UntrustedText {
  return Array.from(value.replace(UNSAFE, '')).slice(0, maxLength).join('') as UntrustedText;
}

export const UntrustedTextSchema = z.string().max(UNTRUSTED_TEXT_MAX * 2);
