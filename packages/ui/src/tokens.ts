// Design tokens: the colours of the style guide (§2), the font stacks (§3) and the shape and space steps (§4).
// tokens.css holds the same values as CSS variables; a test checks that both agree and that every text and status
// colour meets WCAG AA contrast on both backgrounds, in both themes. The light muted and status colours are darker
// than the explorer's (2026-10-13) so that they reach 4.5:1 on --bg as well as on --surface.

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const COLOR_TOKENS = [
  'brand',
  'brand-strong',
  'bar',
  'bg',
  'surface',
  'border',
  'text',
  'muted',
  'success',
  'warning',
  'danger',
  'info',
  // Text and icons on a --danger fill (destructive buttons, the wrong-chain banner): white on the light theme's dark
  // red, near-black on the dark theme's light red (white would reach only 3.14:1 there).
  'on-danger',
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export const COLORS: Record<Theme, Record<ColorToken, string>> = {
  light: {
    brand: '#C4402A',
    'brand-strong': '#9C3321',
    bar: '#822A1C',
    bg: '#F0F4F7',
    surface: '#FFFFFF',
    border: '#E4E7EB',
    text: '#212529',
    muted: '#666F76',
    success: '#177C4D',
    warning: '#8B6700',
    danger: '#D32535',
    info: '#0A7697',
    'on-danger': '#FFFFFF',
  },
  dark: {
    brand: '#C4402A',
    'brand-strong': '#EA8774',
    bar: '#822A1C',
    bg: '#131416',
    surface: '#1B1D1F',
    border: '#25282A',
    text: '#F7FAFA',
    muted: '#B2BAC2',
    success: '#2EB872',
    warning: '#FFC107',
    danger: '#F06272',
    info: '#0DCAF0',
    'on-danger': '#131416',
  },
};

export const FONT_TEXT =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';
export const FONT_MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", "Source Code Pro", Menlo, Consolas, monospace';

// WCAG 2.2 relative luminance and contrast ratio of two #RRGGBB colours.
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
