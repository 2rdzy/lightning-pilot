// Browser entry: the API client, the query cache, the translator for the browser's region and the router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient, ApiError } from './api/client.ts';
import { ApiProvider } from './app/api-context.tsx';
import { createTranslator, MESSAGES_EN, TranslatorProvider } from './app/i18n.tsx';
import { createAppRouter } from './app/router.tsx';
import { safeNext } from './app/session.ts';
import { browserLocale } from './i18n/format.ts';
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
document.documentElement.lang = 'en';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <TranslatorProvider translator={translator}>
      <ApiProvider api={api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ApiProvider>
    </TranslatorProvider>
  </StrictMode>,
);
