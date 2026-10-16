// The tests run in Node: they read tokens.css from disk (the package's own type-check is browser-only).
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COLOR_TOKENS, COLORS, contrast, THEMES } from './tokens.ts';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

// The variables of one CSS block, lower-cased.
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
}

// Text colours must reach 4.5:1 (WCAG 2.2 AA, 1.4.3); colours that only mark a state next to a label or icon, and
// focus rings, 3:1 (1.4.11).
const TEXT = 4.5;
const NON_TEXT = 3;

describe('design tokens', () => {
  it('has the same values in tokens.css as in tokens.ts', () => {
    const light = block(':root');
    const dark = block(":root[data-theme='dark']");
    const system = block(":root:not([data-theme='light'])");
    for (const token of COLOR_TOKENS) {
      expect(light[token], token).toBe(COLORS.light[token].toLowerCase());
      // The dark blocks list only what differs from light.
      const darkValue = dark[token] ?? light[token];
      expect(darkValue, token).toBe(COLORS.dark[token].toLowerCase());
      expect(system[token] ?? light[token], token).toBe(darkValue);
    }
  });

  it('meets AA contrast for every text colour on both backgrounds', () => {
    for (const theme of THEMES) {
      const c = COLORS[theme];
      for (const fg of ['text', 'muted', 'brand-strong', 'success', 'warning', 'danger', 'info'] as const) {
        for (const bg of ['bg', 'surface'] as const) {
          expect(contrast(c[fg], c[bg]), `${theme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(TEXT);
        }
      }
    }
  });

  it('meets 3:1 for the brand as a non-text colour, and AA for labels on filled buttons and the phone bar', () => {
    for (const theme of THEMES) {
      const c = COLORS[theme];
      for (const bg of ['bg', 'surface'] as const) {
        expect(contrast(c.brand, c[bg]), `${theme} brand on ${bg}`).toBeGreaterThanOrEqual(NON_TEXT);
      }
      expect(contrast('#FFFFFF', c.brand), `${theme} white on brand`).toBeGreaterThanOrEqual(TEXT);
      expect(contrast('#FFFFFF', c['brand-hover']), `${theme} white on brand-hover`).toBeGreaterThanOrEqual(TEXT);
      expect(contrast('#FFFFFF', c.bar), `${theme} white on bar`).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(c['on-danger'], c.danger), `${theme} on-danger on danger`).toBeGreaterThanOrEqual(TEXT);
    }
  });

  it('computes the WCAG ratio', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
  });
});
