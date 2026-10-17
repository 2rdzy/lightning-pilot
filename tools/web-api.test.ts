// The web app's API routes (apps/web/src/api/endpoints.ts) against the server's OpenAPI document: every route the
// browser calls exists with that method, answers with the status the client expects, and uses the same request and
// response schemas. This replaces a generated client (no generator is in the agreed dependencies): a server change
// that the web app has not followed fails here, not in the browser.
import { describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../apps/web/src/index.ts';
import { loadConfig } from '../apps/server/src/config/config.ts';
import { openApiDocument } from '../apps/server/src/http/app.ts';
import { createLogger } from '../apps/server/src/logging/logger.ts';
import { buildServer } from '../apps/server/src/server.ts';
import { tempDir, testDriver, writeVaultKey } from '../apps/server/src/testing.ts';

interface Operation {
  parameters?: { in?: string; name?: string }[];
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
}

// The component a shared schema becomes in the document: its registered id (`.meta({ id })` in core's api.ts).
const refId = (schema: { meta(): { id?: string | undefined } | undefined } | undefined) =>
  schema === undefined ? undefined : `#/components/schemas/${String(schema.meta()?.id)}`;

describe('web API client against the OpenAPI document', () => {
  it('matches every route the web app calls', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const vaultKey = writeVaultKey(dir);
      const { config } = loadConfig({
        readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: dir, vaultKey } }),
      });
      const server = await buildServer({
        config,
        vaultKeyPath: vaultKey,
        dev: false,
        logger: createLogger({ level: 'error', sink: () => undefined, stdout: () => undefined }),
        driver: testDriver(),
      });
      const doc = openApiDocument(server.app);
      await server.close();

      for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
        const operation = (doc.paths?.[endpoint.path] as Record<string, Operation> | undefined)?.[
          endpoint.method.toLowerCase()
        ];
        expect(operation, `${name}: ${endpoint.method} ${endpoint.path}`).toBeDefined();
        const success = Object.keys(operation?.responses ?? {}).filter((s) => s.startsWith('2'));
        expect(success, name).toEqual([String(endpoint.status)]);
        const body = operation?.requestBody?.content?.['application/json']?.schema;
        if (endpoint.body && !endpoint.body.meta()?.id) {
          // Inline request contracts (setup-command, WP14): compare the complete schema, as for responses below.
          const path = `/__client-request/${name}`;
          server.app.openAPIRegistry.registerPath({
            method: 'post',
            path,
            request: { body: { content: { 'application/json': { schema: endpoint.body } } } },
            responses: { 204: { description: 'Client contract' } },
          });
          const expected = openApiDocument(server.app).paths?.[path]?.post?.requestBody;
          expect(body, `${name}: documented request body`).toBeDefined();
          expect(body, name).toEqual(
            expected && 'content' in expected ? expected.content?.['application/json']?.schema : undefined,
          );
        } else expect(body?.$ref, name).toBe(refId(endpoint.body));
        // Query parameters: the client sends exactly the names the server documents (paged lists).
        const documented = (operation?.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
        const query = 'query' in endpoint ? (endpoint.query as { shape?: Record<string, unknown> }).shape : undefined;
        expect(documented.sort(), name).toEqual(Object.keys(query ?? {}).sort());
        const response = operation?.responses?.[String(endpoint.status)]?.content?.['application/json']?.schema;
        if (endpoint.response && !endpoint.response.meta()?.id) {
          // Some existing read contracts are inline in OpenAPI. Compare their complete schema rather than
          // requiring a component name or accepting two absent references as a match.
          const path = `/__client-contract/${name}`;
          server.app.openAPIRegistry.registerPath({
            method: 'get',
            path,
            responses: {
              200: { description: 'Client contract', content: { 'application/json': { schema: endpoint.response } } },
            },
          });
          const expected = openApiDocument(server.app).paths?.[path]?.get?.responses?.['200'];
          expect(response, name).toEqual(
            expected && 'content' in expected ? expected.content?.['application/json']?.schema : undefined,
          );
        } else {
          expect(response?.$ref, name).toBe(refId(endpoint.response));
        }
      }
    } finally {
      cleanup();
    }
  });
});
