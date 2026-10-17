// Browser entry: the API client, the query cache, the translator for the browser's region, the display preferences,
// the design system and the router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { DesignSystemProvider } from '@lightning-pilot/ui';
import { StrictMode, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient, ApiError } from './api/client.ts';
import { ApiProvider } from './app/api-context.tsx';
import { createTranslator, MESSAGES_EN, TranslatorProvider } from './app/i18n.tsx';
import { createAppRouter } from './app/router.tsx';
import { safeNext } from './app/session.ts';
import { browserLocale } from './i18n/format.ts';
import { PreferencesProvider, storage, usePreferences } from './shell/preferences-context.tsx';
import { applyTheme, readPreferences } from './shell/preferences.ts';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A refused request (4xx) will not succeed by asking again; network and node errors may.
      retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      refetchOnWindowFocus: false,
    },
  },
});

// A 401 anywhere means the session is gone: back to the login screen, then return here afterwards.
const api: ApiClient = new ApiClient({
  onUnauthenticated: () => {
    queryClient.clear();
    const here = safeNext(`${window.location.pathname}${window.location.search}`);
    void router.navigate({ to: '/login', search: here === undefined || here === '/' ? {} : { next: here } });
  },
});
const router = createAppRouter({ api, queryClient });
const translator = createTranslator(MESSAGES_EN, browserLocale(navigator.languages));

// Numbers and dates follow the region chosen in Settings › Display, or the browser's (style guide §6a).
function RegionTranslator({ children }: { children: ReactNode }) {
  const { region } = usePreferences();
  const regional = useMemo(() => (region === undefined ? translator : createTranslator(MESSAGES_EN, region)), [region]);
  return <TranslatorProvider translator={regional}>{children}</TranslatorProvider>;
}
document.documentElement.lang = 'en';
// The chosen theme before the first render, so the page does not flash in the other one. (Not an inline script in
// index.html: the CSP allows scripts from 'self' only.)
applyTheme(document.documentElement, readPreferences(storage()).theme);

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <TranslatorProvider translator={translator}>
      <ApiProvider api={api}>
        <QueryClientProvider client={queryClient}>
          <PreferencesProvider>
            <RegionTranslator>
              <DesignSystemProvider closeLabel={translator.t('common.close')}>
                <RouterProvider router={router} />
              </DesignSystemProvider>
            </RegionTranslator>
          </PreferencesProvider>
        </QueryClientProvider>
      </ApiProvider>
    </TranslatorProvider>
  </StrictMode>,
);
