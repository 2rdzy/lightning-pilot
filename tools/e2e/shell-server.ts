// An in-process server for the shell, accessibility and visual tests: the built web app, setup already done, and
// the fake nodes alice and bob (Bitcoin BLAKE2b) and carol (Bitcoin SHA256d), as the development server has them.
// Each test gets its own (setup runs once per database), on a free port, and logs in through the real login screen.
import { expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { FakeAdapter, FakeNetwork } from '../../packages/adapter-kit/src/index.ts';
import type { Chain, SetupLimits } from '../../packages/core/src/index.ts';
import { loadConfig } from '../../apps/server/src/config/config.ts';
import { listen } from '../../apps/server/src/http/listen.ts';
import { createLogger } from '../../apps/server/src/logging/logger.ts';
import { totp } from '../../apps/server/src/modules/auth/totp/totp.ts';
import { buildServer } from '../../apps/server/src/server.ts';
import { setupForTest, tempDir, testRune, testSpendPolicy, writeVaultKey } from '../../apps/server/src/testing.ts';

export const SHELL_PASSWORD = 'Shell-browser-account-9!';
const FAKE_CA = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
const NODES: { name: string; chain: Chain }[] = [
  { name: 'alice', chain: 'blake2b' },
  { name: 'bob', chain: 'blake2b' },
  { name: 'carol', chain: 'bitcoin' },
];

export interface ShellServer {
  url: string;
  secret: string;
  close: () => Promise<void>;
}

// `live` starts the node event workers, so the browser's live connection carries real node events (WP18: an
// invoice paid by another fake node).
export async function startShellServer(
  options: {
    spending?: boolean;
    readOnly?: boolean;
    live?: boolean;
    // Changes to the test spending policy (with `spending`), e.g. a step-up threshold (WP19).
    limits?: Partial<SetupLimits>;
    // Fee-cap modes of the test policy (not part of `SetupLimits`; the settings screen changes them with security
    // step-up), written straight into the database.
    feeModes?: { maxFeeRateMode?: 'refuse' | 'step-up'; maxFeeShareMode?: 'refuse' | 'step-up' };
  } = {},
): Promise<ShellServer> {
  const tmp = tempDir();
  const key = writeVaultKey(tmp.dir);
  let token = '';
  const logger = createLogger({
    sink: () => {},
    stdout: (line) => {
      const entry = JSON.parse(line) as { setupToken?: string };
      if (entry.setupToken) token = entry.setupToken;
    },
  });
  const { config } = loadConfig({
    readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: tmp.dir, vaultKey: key } }),
  });
  config.server.port = 0;
  const world = new FakeNetwork();
  const fakes = new Map(
    NODES.map((n) => [`https://${n.name}.fake.invalid`, new FakeAdapter({ chain: n.chain, alias: n.name, world })]),
  );
  const server = await buildServer({
    config,
    vaultKeyPath: key,
    dev: true,
    logger,
    scryptCost: { log2N: 10, r: 8, p: 1 },
    webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
    adapterFactory: (connection) => {
      const fake = fakes.get(connection.url);
      if (!fake) throw new Error(`no fake node at ${connection.url}`);
      return fake;
    },
  });
  const { secret } = await setupForTest(server.setup, token, SHELL_PASSWORD);
  for (const node of NODES) {
    await server.nodes.add(
      {
        name: node.name,
        implementation: 'cln',
        chain: node.chain,
        network: 'regtest',
        url: `https://${node.name}.fake.invalid`,
        caCertificate: FAKE_CA,
        serverName: 'localhost',
        viewRune: testRune('read'),
        ...(options.readOnly ? { accessLevel: 'read-only' as const } : { spendRune: testRune('spend') }),
        ...(options.spending ? { limits: { ...testSpendPolicy, ...options.limits } } : {}),
      },
      'r-shell',
    );
  }
  if (options.feeModes)
    await server.db
      .updateTable('spend_limits')
      .set({
        ...(options.feeModes.maxFeeRateMode ? { max_fee_rate_mode: options.feeModes.maxFeeRateMode } : {}),
        ...(options.feeModes.maxFeeShareMode ? { max_fee_share_mode: options.feeModes.maxFeeShareMode } : {}),
      })
      .execute();
  if (options.live) server.events.workers.start();
  const listener = listen(server.app, config, logger);
  const url = `http://localhost:${await listener.port}`;
  return {
    url,
    secret,
    close: async () => {
      await server.events.streams.stop();
      await listener.close();
      await server.close();
      tmp.cleanup();
    },
  };
}

// Logs in with the current TOTP code (setup used the previous window) and waits for the dashboard.
export async function logIn(page: Page, server: ShellServer): Promise<void> {
  await page.goto(`${server.url}/login`);
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(SHELL_PASSWORD);
  await page.getByLabel('Authenticator code').fill(totp(server.secret, new Date()));
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByTestId('balance-spendable')).toBeVisible();
}

// Collects console errors and page errors; a CSP violation is one. 401s while logged out are expected.
export function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/status of 401 \(Unauthorized\)/.test(msg.text())) problems.push(msg.text());
  });
  page.on('pageerror', (err) => problems.push(err.message));
  return problems;
}
