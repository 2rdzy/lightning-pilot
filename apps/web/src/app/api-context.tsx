// The API client for components (the router has it in its context for loaders).
import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient } from '../api/client.ts';

const ApiContext = createContext<ApiClient | undefined>(undefined);

export function ApiProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi outside ApiProvider');
  return api;
}
