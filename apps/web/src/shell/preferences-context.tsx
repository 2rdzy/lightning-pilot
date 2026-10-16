// The display preferences as React state: the view (Basic/Advanced), the theme and whether the screen is phone-sized.
// Changes are kept in the browser (preferences.ts) and the theme is applied to <html> at once.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyTheme,
  effectiveView,
  PHONE_QUERY,
  readPreferences,
  writePreferences,
  type Preferences,
  type ThemeChoice,
  type View,
} from './preferences.ts';

interface PreferencesValue {
  view: View;
  theme: ThemeChoice;
  isPhone: boolean;
  setView: (view: View) => void;
  setTheme: (theme: ThemeChoice) => void;
}

const PreferencesContext = createContext<PreferencesValue | undefined>(undefined);

export function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function phoneQuery(): MediaQueryList | undefined {
  return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(PHONE_QUERY) : undefined;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(() => readPreferences(storage()));
  const [isPhone, setIsPhone] = useState(() => phoneQuery()?.matches ?? false);

  useEffect(() => {
    const query = phoneQuery();
    if (!query) return;
    const update = () => setIsPhone(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    applyTheme(document.documentElement, prefs.theme);
    writePreferences(storage(), prefs);
  }, [prefs]);

  const value = useMemo<PreferencesValue>(
    () => ({
      view: effectiveView(prefs, isPhone),
      theme: prefs.theme,
      isPhone,
      setView: (view) => setPrefs((p) => ({ ...p, view })),
      setTheme: (theme) => setPrefs((p) => ({ ...p, theme })),
    }),
    [prefs, isPhone],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('usePreferences outside PreferencesProvider');
  return value;
}
