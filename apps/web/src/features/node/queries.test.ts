import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { refreshNodeReads } from './queries.ts';

describe('node screen reads', () => {
  it('marks cached reads stale after stream events without altering another feature cache', async () => {
    const client = new QueryClient();
    for (const key of ['node', 'balances', 'node-details', 'node-credentials', 'invoice', 'session-policy']) {
      client.setQueryData([key, 'alice'], { saved: true });
    }
    await refreshNodeReads(client);
    for (const key of ['node', 'balances', 'node-details', 'node-credentials', 'invoice']) {
      expect(client.getQueryState([key, 'alice'])?.isInvalidated).toBe(true);
      expect(client.getQueryData([key, 'alice'])).toEqual({ saved: true });
    }
    expect(client.getQueryState(['session-policy', 'alice'])?.isInvalidated).toBe(false);
  });
});
