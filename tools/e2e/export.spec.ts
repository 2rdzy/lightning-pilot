import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ExportEnvelope } from '../../packages/core/src/index.ts';
import { loadConfig } from '../../apps/server/src/config/config.ts';
import { createLogger } from '../../apps/server/src/logging/logger.ts';
import { buildServer } from '../../apps/server/src/server.ts';
import { listen } from '../../apps/server/src/http/listen.ts';
import { setupForTest, tempDir, writeVaultKey } from '../../apps/server/src/testing.ts';
import { totp } from '../../apps/server/src/modules/auth/totp/totp.ts';

const PASSWORD = 'Export-browser-account-9!';
const PASSPHRASE = 'separate four word export passphrase';

test('encrypted download and import into a fresh destination account without the source key', async ({
  page,
  browser,
}) => {
  const cleanup: (() => Promise<void> | void)[] = [];
  const logs: string[] = [];
  async function instance(_context: BrowserContext, p: Page) {
    const tmp = tempDir();
    cleanup.unshift(tmp.cleanup);
    const key = writeVaultKey(tmp.dir);
    let token = '';
    const logger = createLogger({
      sink: (line) => logs.push(line),
      stdout: (line) => {
        const entry = JSON.parse(line) as { setupToken?: string };
        if (entry.setupToken) token = entry.setupToken;
      },
    });
    const { config } = loadConfig({
      readFile: () => JSON.stringify({ tls: { mode: 'off' }, paths: { dataDir: tmp.dir, vaultKey: key } }),
    });
    config.server.port = 0;
    const server = await buildServer({
      config,
      vaultKeyPath: key,
      dev: true,
      logger,
      scryptCost: { log2N: 10, r: 8, p: 1 },
      webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
    });
    // The settings shell holds a live event stream open; stop it first, as shell-server.ts does.
    const closeServer = async () => {
      await server.events.streams.stop();
      await server.close();
    };
    cleanup.unshift(closeServer);
    const setup = await setupForTest(server.setup, token, PASSWORD);
    const listener = listen(server.app, config, logger);
    cleanup.unshift(async () => {
      await server.events.streams.stop();
      await listener.close();
    });
    const url = `http://localhost:${await listener.port}`;
    await p.goto(`${url}/login`);
    await p.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await p.getByLabel('Authenticator code').fill(totp(setup.secret, new Date()));
    await p.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(p.getByRole('heading', { name: 'No node yet' })).toBeVisible();
    await p.goto(`${url}/settings/export`);
    await expect(p.getByRole('heading', { name: 'Export and import' })).toBeVisible();
    await p.getByRole('button', { name: 'Re-authenticate', exact: true }).click();
    // Inject one server refusal to prove the modal announces errors before the real step-up.
    await p.route('**/api/v1/auth/step-up', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'step_up_required', message: 'Please re-authenticate.', requestId: 'r-browser-test' },
        }),
      }),
    );
    await p.getByLabel('Account password').fill(PASSWORD);
    await p.getByLabel('Authenticator code').fill(totp(setup.secret, new Date(Date.now() + 30_000)));
    await p.getByRole('button', { name: 'Confirm identity' }).click();
    await expect(p.getByRole('dialog').getByRole('alert')).toHaveText('Please re-authenticate.');
    await p.unroute('**/api/v1/auth/step-up');
    await p.getByLabel('Account password').fill(PASSWORD);
    await p.getByLabel('Authenticator code').fill(totp(setup.secret, new Date(Date.now() + 30_000)));
    await p.getByRole('button', { name: 'Confirm identity' }).click();
    await expect(p.getByText('Identity confirmed.', { exact: false })).toBeVisible();
    return { server, url, closeServer };
  }
  try {
    const source = await instance(page.context(), page);
    await page.getByLabel('Export passphrase', { exact: true }).fill(PASSPHRASE);
    await page.getByLabel('Confirm export passphrase').fill(PASSPHRASE);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download encrypted export' }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).toBeTruthy();
    const contents = readFileSync(path ?? '', 'utf8');
    expect(ExportEnvelope.safeParse(JSON.parse(contents)).success).toBe(true);
    expect(contents).not.toContain(PASSPHRASE);
    await expect(page.getByLabel('Export passphrase', { exact: true })).toHaveValue('');
    // Close the source vault before opening the destination: it cannot supply its key to import.
    await source.closeServer();
    cleanup.splice(cleanup.indexOf(source.closeServer), 1);
    const context = await browser.newContext({ viewport: page.viewportSize() });
    cleanup.unshift(() => context.close());
    const destinationPage = await context.newPage();
    await instance(context, destinationPage);
    await destinationPage.getByLabel('Export passphrase', { exact: true }).fill(PASSPHRASE);
    await destinationPage
      .getByLabel('Encrypted export file')
      .setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(contents) });
    await destinationPage.getByRole('button', { name: 'Import new records' }).click();
    await expect(destinationPage.getByText('Import completed.', { exact: false })).toBeVisible();
    await expect(destinationPage.getByLabel('Export passphrase', { exact: true })).toHaveValue('');
    await destinationPage.screenshot({ path: test.info().outputPath('settings-export.png'), fullPage: true });
    expect(logs.join('\n')).not.toContain(PASSPHRASE);
    expect(logs.join('\n')).not.toContain(PASSWORD);
  } finally {
    for (const fn of cleanup) await fn();
  }
});
