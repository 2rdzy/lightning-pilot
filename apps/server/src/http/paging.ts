// The page query of a list route as the adapter's page request (optional fields left out, not undefined).
import type { PageQuery, PageRequest } from '@lightning-pilot/core';

export const pageRequest = (query: PageQuery): PageRequest => ({
  ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  ...(query.limit === undefined ? {} : { limit: query.limit }),
});
