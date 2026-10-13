// Development server: the real server (buildServer) in development mode over plain HTTP on loopback, with nodes
// already added, so the web app can be worked on and tested end to end. Never part of a release: it lives in
// tools/, which the server may not import, and the production entry (apps/server/src/main.ts) knows nothing of it.
//
//   node tools/dev/server.ts [--nodes fake|regtest] [--port 8080] [--web <dir>] [--data <dir>]
//
// --nodes fake (default): in-memory fake nodes that can pay each other: alice and bob on Bitcoin BLAKE2b, carol on
//   Bitcoin (SHA256d). Nothing else needs to run.
// --nodes regtest: cln-a and cln-b of the tools/regtest environment of LP_REGTEST_CHAIN (blake2b | sha256d), added as
//   alice and bob with the same restricted runes a real installation uses. Start the environment first.
// --web: serve a built web app (apps/web/dist) as the release does; without it, use the Vite dev server's proxy.
// --data: keep the database and its vault key there; by default a new temporary directory is used and removed on
//   exit. The fake nodes' state is in memory and starts afresh on every run.
//
// The setup token is printed in the log as in production; the nodes are added as soon as setup has created the
// owner (the vault holding their credentials is initialised then). Configuration comes from the flags only: no LP_*
// variable of the environment is read (the config loader refuses unknown ones, and the regtest script uses some).
import { acquireServiceLock } from '../../apps/server/src/modules/setup/reset.ts';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FakeAdapter, FakeNetwork } from '../../packages/adapter-kit/src/index.ts';
import type { Chain, Network } from '../../packages/core/src/index.ts';
import { loadConfig } from '../../apps/server/src/config/config.ts';
import { listen } from '../../apps/server/src/http/listen.ts';
import { createLogger } from '../../apps/server/src/logging/logger.ts';
import { clnAdapterFactory, type AdapterFactory } from '../../apps/server/src/modules/nodes/index.ts';
import { buildServer } from '../../apps/server/src/server.ts';
import { writeVaultKey } from '../../apps/server/src/testing.ts';
import { creds, profileOf, regtestChain } from '../regtest/nodes.ts';

const { values } = parseArgs({
  options: {
    nodes: { type: 'string', default: 'fake' },
    port: { type: 'string', default: '8080' },
    web: { type: 'string' },
    data: { type: 'string' },
  },
});
if (values.nodes !== 'fake' && values.nodes !== 'regtest') throw new Error('--nodes must be fake or regtest');
const port = Number(values.port);

const temporary = values.data === undefined;
const dataDir = values.data ? resolve(values.data) : mkdtempSync(join(tmpdir(), 'lp-dev-'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const release = acquireServiceLock(dataDir);
// A key already in --data belongs to its database: reuse it, never replace it.
const existingKey = join(dataDir, 'vault-key');
const vaultKey = existsSync(existingKey) ? existingKey : writeVaultKey(dataDir, randomBytes(32));
const { config } = loadConfig({
  env: {},
  readFile: () =>
    JSON.stringify({
      server: { listen: '127.0.0.1', port, hosts: ['localhost'] },
      tls: { mode: 'off' },
      paths: { dataDir, vaultKey },
      log: { level: 'info' },
    }),
});
const logger = createLogger({ level: 'info' });

interface DevNode {
  name: string;
  chain: Chain;
  network: Network;
  url: string;
  caCertificate: string;
  serverName: string;
  viewRune: string;
  spendRune: string;
}

// Fake connection details: the fake adapter ignores them, but the server stores and encrypts them as usual.
const FAKE_CA = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
const fakeNode = (name: string, chain: Chain): DevNode => ({
  name,
  chain,
  network: 'regtest',
  url: `https://${name}.fake.invalid`,
  caCertificate: FAKE_CA,
  serverName: 'localhost',
  viewRune: `fake-view-${name}`,
  spendRune: `fake-spend-${name}`,
});

let nodes: DevNode[];
let adapterFactory: AdapterFactory;
if (values.nodes === 'fake') {
  nodes = [fakeNode('alice', 'blake2b'), fakeNode('bob', 'blake2b'), fakeNode('carol', 'bitcoin')];
  const world = new FakeNetwork();
  const fakes = new Map(nodes.map((n) => [n.url, new FakeAdapter({ chain: n.chain, alias: n.name, world })]));
  adapterFactory = (connection) => {
    const fake = fakes.get(connection.url);
    if (!fake) throw new Error(`no fake node at ${connection.url}`);
    return fake;
  };
} else {
  const chain = regtestChain();
  if (!chain) throw new Error('--nodes regtest needs LP_REGTEST_CHAIN=blake2b|sha256d');
  nodes = (
    [
      ['alice', 'cln-a'],
      ['bob', 'cln-b'],
    ] as const
  ).map(([name, cln]) => {
    const view = creds(chain, cln, 'view');
    return {
      name,
      chain: profileOf(chain),
      network: 'regtest',
      url: view.url,
      caCertificate: view.caCertificate,
      serverName: view.serverName,
      viewRune: view.rune,
      spendRune: creds(chain, cln, 'spend').rune,
    };
  });
  adapterFactory = clnAdapterFactory;
}

const server = await buildServer({
  config,
  vaultKeyPath: vaultKey,
  dev: true,
  logger,
  adapterFactory,
  ...(values.web ? { webRoot: resolve(values.web) } : {}),
});
// Nodes need the vault, and the vault is initialised when setup creates the owner: add them then (or at once when
// --data holds a finished setup).
async function addNodes(): Promise<void> {
  const existing = new Set((await server.nodes.list()).map((n) => n.name));
  for (const node of nodes) {
    if (existing.has(node.name)) continue;
    const { name, ...input } = node;
    await server.nodes.add({ name, implementation: 'cln', ...input }, 'r-dev');
  }
  logger.info('development nodes ready', { nodes: nodes.map((n) => n.name) });
}
if (!server.auth.setupMode) await addNodes();
const app = {
  fetch: async (request: Request, env?: unknown) => {
    const res = await server.app.fetch(request, env);
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/api/v1/setup' &&
      res.status === 200 &&
      !server.auth.setupMode
    ) {
      await addNodes();
    }
    return res;
  },
};

const listener = listen(app, config, logger);
server.nodes.monitor.start();
logger.info('development server ready', {
  url: `http://localhost:${await listener.port}`,
  nodes: values.nodes,
  web: values.web ? 'built app' : 'API only: open the Vite dev server (pnpm dev:web)',
});

const stop = () => {
  void Promise.all([listener.close(), server.close()]).finally(() => {
    release();
    if (temporary) rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
