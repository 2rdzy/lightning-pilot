// A server process that dies at a chosen point of a spend, for the crash-recovery regtest test. It previews and
// executes one spend through the API with the owner's session, and kills itself with SIGKILL (no clean-up, no
// outcome write) either just before the fund-moving node call or just after the node answered.
// Usage: node tools/regtest/crash-child.ts '<json>' with { dir, vaultKey, cookie, csrf, nodeId, kind, body, key, at }.
import { createClnAdapter } from '../../packages/adapter-cln/src/index.ts';
import type { NodeAdapter } from '../../packages/core/src/index.ts';
import { loadConfig } from '../../apps/server/src/config/config.ts';
import { createLogger } from '../../apps/server/src/logging/logger.ts';
import { buildServer } from '../../apps/server/src/server.ts';

interface Job {
  dir: string;
  vaultKey: string;
  cookie: string;
  csrf: string;
  nodeId: string;
  // Path below /api/v1/nodes/{nodeId}/ of the preview and execute routes, e.g. 'payments'.
  kind: string;
  // Fund-moving adapter method to interrupt, e.g. 'pay.pay' or 'onchain.send'.
  method: string;
  body: Record<string, unknown>;
  key: string;
  at: 'before' | 'after';
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;
const die = () => process.kill(process.pid, 'SIGKILL');

function interrupting(adapter: NodeAdapter): NodeAdapter {
  const [port, name] = job.method.split('.') as [keyof NodeAdapter, string];
  const original = adapter[port] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const call = original[name];
  if (!call) throw new Error(`no adapter method ${job.method}`);
  const wrapped = async (...args: unknown[]) => {
    if (job.at === 'before') die();
    const result = await call.apply(original, args);
    die();
    return result;
  };
  return { ...adapter, [port]: { ...original, [name]: wrapped } } as NodeAdapter;
}

const { config } = loadConfig({
  readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: job.dir, vaultKey: job.vaultKey } }),
});
const server = await buildServer({
  config,
  vaultKeyPath: job.vaultKey,
  dev: true,
  logger: createLogger({ sink: () => undefined }),
  issueSetupToken: false,
  adapterFactory: (connection) => interrupting(createClnAdapter(connection)),
});
const headers = {
  host: 'localhost',
  origin: 'https://localhost',
  'content-type': 'application/json',
  cookie: job.cookie,
  'x-csrf-token': job.csrf,
};
const base = `/api/v1/nodes/${job.nodeId}/${job.kind}`;
const preview = await server.app.request(`${base}/preview`, {
  method: 'POST',
  headers,
  body: JSON.stringify(job.body),
});
const previewed = (await preview.json()) as { confirmationToken?: string };
if (!previewed.confirmationToken) {
  process.stdout.write(`preview refused: ${JSON.stringify(previewed)}\n`);
  process.exit(2);
}
const executed = await server.app.request(`${base}/execute`, {
  method: 'POST',
  headers: { ...headers, 'idempotency-key': job.key },
  body: JSON.stringify({ confirmationToken: previewed.confirmationToken, acknowledgeDuplicate: true }),
});
// Reached only if the wrapped node call was never made.
process.stdout.write(`execute answered ${executed.status}: ${await executed.text()}\n`);
process.exit(3);
