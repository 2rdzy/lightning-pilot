// Display preferences of this device (style guide §1, §2, §6a; personas §1): the Basic or Advanced view, the theme
// and the region whose number and date format the app uses (the browser's by default).
// They only hide or show things; what the server allows never depends on them. Stored in the browser per device;
// with storage blocked the defaults apply: Advanced on a desktop-sized screen, Basic on a phone, theme from the system.

export type View = 'basic' | 'advanced';
export type ThemeChoice = 'system' | 'light' | 'dark';

export const VIEWS: readonly View[] = ['basic', 'advanced'];
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

// Regions offered for the number and date format besides the browser's own (style guide §6a: Tor Browser reports
// en-US to everyone). Grouping and decimal marks differ between them; the interface language stays English.
export const REGIONS: readonly string[] = [
  'en-US',
  'en-GB',
  'de-DE',
  'de-CH',
  'fr-FR',
  'es-ES',
  'it-IT',
  'nl-NL',
  'pt-BR',
  'en-IN',
  'ja-JP',
];

// The phone layout's breakpoint, the same as Tailwind's `md` (768 px).
export const PHONE_QUERY = '(max-width: 767px)';

const VIEW_KEY = 'lp.view';
const THEME_KEY = 'lp.theme';
const REGION_KEY = 'lp.region';

export interface Preferences {
  // undefined: never chosen on this device, so the default for the screen size applies (and follows it).
  view: View | undefined;
  theme: ThemeChoice;
  // undefined: the browser's region.
  region: string | undefined;
}

type Reader = Pick<Storage, 'getItem'> | undefined;
type Writer = Pick<Storage, 'setItem' | 'removeItem'> | undefined;

function read(storage: Reader, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function readPreferences(storage: Reader): Preferences {
  const view = read(storage, VIEW_KEY);
  const theme = read(storage, THEME_KEY);
  const region = read(storage, REGION_KEY);
  return {
    view: VIEWS.includes(view as View) ? (view as View) : undefined,
    theme: THEME_CHOICES.includes(theme as ThemeChoice) ? (theme as ThemeChoice) : 'system',
    region: region !== null && REGIONS.includes(region) ? region : undefined,
  };
}

export function writePreferences(storage: Writer, prefs: Preferences): void {
  try {
    if (prefs.view === undefined) storage?.removeItem(VIEW_KEY);
    else storage?.setItem(VIEW_KEY, prefs.view);
    if (prefs.theme === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, prefs.theme);
    if (prefs.region === undefined) storage?.removeItem(REGION_KEY);
    else storage?.setItem(REGION_KEY, prefs.region);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

export function effectiveView(prefs: Preferences, isPhone: boolean): View {
  return prefs.view ?? (isPhone ? 'basic' : 'advanced');
}

// tokens.css follows the system unless <html data-theme> says light or dark.
export function applyTheme(root: { dataset: DOMStringMap }, theme: ThemeChoice): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}
