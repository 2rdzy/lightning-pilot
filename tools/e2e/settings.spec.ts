// WP20a stories in the browser, through the real server with the fake nodes alice and bob (BLAKE2b) and carol
// (SHA256d): the settings overview, display (U13 view, number format), security and sessions (U10), nodes (add with
// the limits step, recheck, replace, remove), spending limits (U9) and unresolved spends.
// TOTP codes are single-use across login and step-up, so each test logs in with the current window's code and makes
// at most one security step-up, with the next window's code; the grant then lasts five minutes.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { totp } from '../../apps/server/src/modules/auth/totp/totp.ts';
import { testRune } from '../../apps/server/src/testing.ts';
import { expectAccessible } from './axe.ts';
import { FAKE_CA, logIn, SHELL_PASSWORD, startShellServer, watchConsole, type ShellServer } from './shell-server.ts';

let server: ShellServer | undefined;
test.afterEach(async () => {
  await server?.close();
  server = undefined;
});

type NodeName = 'alice' | 'bob' | 'carol' | 'dave';

async function start(page: Page, options: Parameters<typeof startShellServer>[0] = {}) {
  server = await startShellServer(options);
  await logIn(page, server);
  return nodeIds(page);
}

async function nodeIds(page: Page): Promise<Partial<Record<NodeName, string>>> {
  const url = (server as ShellServer).url;
  const { items } = (await (await page.request.get(`${url}/api/v1/nodes`)).json()) as {
    items: { id: string; name: NodeName }[];
  };
  return Object.fromEntries(items.map((n) => [n.name, n.id]));
}

// A protected action is tried first and answered 403 step_up_required while no grant is live; that refusal (and the
// 400 of a refused value) is how the screens find out, so the browser's resource errors for them are expected.
const unexpected = (problems: string[]) => problems.filter((p) => !/status of 40[03] \(/.test(p));

const nextCode = (s: ShellServer, secret = s.secret) => totp(secret, new Date(Date.now() + 30_000));

// Answers the security step-up dialog with the password and the next window's code.
async function stepUp(page: Page, s: ShellServer) {
  const dialog = page.getByTestId('step-up');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password', { exact: true }).fill(SHELL_PASSWORD);
  await dialog.getByLabel('Authenticator code').fill(nextCode(s));
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('overview, display region and the Advanced note on node settings', async ({ page }, testInfo) => {
  const problems = watchConsole(page);
  const ids = await start(page);
  const phone = testInfo.project.name === 'phone';
  // Settings is reached from the navigation: the side bar on a desktop, More on a phone.
  if (phone) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click();
    await page.getByTestId('menu-panel').getByRole('link', { name: 'Settings' }).click();
  } else await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  for (const name of ['Security', 'Sessions and devices', 'Nodes', 'Unresolved spends', 'Display', 'Export and import'])
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(page.getByTestId('unresolved-count')).toHaveText('0 unresolved');
  // The shell keeps the last used node in the top bar on app-wide screens.
  await expect(page.getByTestId('node-select')).toHaveValue(ids.alice ?? '');
  await expectAccessible(page, 'settings overview');

  await page.getByRole('link', { name: 'Display', exact: true }).click();
  await expect(page.getByTestId('display-sample')).toContainText('1,250,000 sat');
  await page.getByTestId('display-region').selectOption('de-DE');
  await expect(page.getByTestId('display-sample')).toContainText('1.250.000 sat');
  await expect(page.getByTestId('display-sample')).toContainText('0,01250000');
  await expectAccessible(page, 'display settings');
  await page.getByTestId('display-theme').getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectAccessible(page, 'display settings, dark');
  await page.goto(`${(server as ShellServer).url}/settings`);
  await expectAccessible(page, 'settings overview, dark');
  // Every amount follows: the fake node's 500,000 sat on-chain balance, after a reload too.
  await page.goto(`${(server as ShellServer).url}/n/${ids.alice}`);
  await expect(page.getByTestId('balance-onchain')).toContainText('500.000');
  await page.reload();
  await expect(page.getByTestId('balance-onchain')).toContainText('500.000');

  // Node settings belong to the Advanced view; opened in Basic they say so (a phone starts in Basic).
  await page.goto(`${(server as ShellServer).url}/settings/display`);
  await page.getByTestId('display-view').getByRole('button', { name: 'Basic' }).click();
  await page.goto(`${(server as ShellServer).url}/settings/nodes`);
  await expect(page.getByTestId('advanced-only')).toBeVisible();
  await page.goto(`${(server as ShellServer).url}/settings/security`);
  await expect(page.getByTestId('advanced-only')).toBeHidden();
  expect(unexpected(problems)).toEqual([]);
});

test('U10: recovery codes behind a step-up, new codes once, password change', async ({ page }) => {
  const problems = watchConsole(page);
  await start(page);
  const s = server as ShellServer;
  await page.goto(`${s.url}/settings/security`);
  await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
  await expectAccessible(page, 'security settings');
  await page.getByRole('button', { name: 'Show how many are left' }).click();
  // A wrong code shape is caught before the request.
  const dialog = page.getByTestId('step-up');
  await dialog.getByLabel('Password', { exact: true }).fill(SHELL_PASSWORD);
  await dialog.getByLabel('Authenticator code').fill('12');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter the six digits your authenticator app shows.');
  await stepUp(page, s);
  await expect(page.getByTestId('recovery-remaining')).toHaveText('10 unused recovery codes left.');

  await page.getByRole('button', { name: 'Make new recovery codes' }).click();
  await expect(page.getByTestId('destructive-confirm')).toContainText('the old codes stop working');
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(10);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download as a text file' }).click();
  expect((await download).suggestedFilename()).toBe('lightning-pilot-recovery-codes.txt');
  await page.getByRole('button', { name: 'I have saved them' }).click();
  await expect(page.getByTestId('recovery-codes')).toBeHidden();

  // The password rule is checked before anything is sent; the grant from above covers the change.
  await page.getByLabel('New password', { exact: true }).fill('short');
  await page.getByLabel('Repeat the new password').fill('short');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'At least 12 characters' })).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill('Another-browser-pass-7!');
  await page.getByLabel('Repeat the new password').fill('Another-browser-pass-7!');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed. Every other session has ended.')).toBeVisible();
  expect(unexpected(problems)).toEqual([]);
});

test('U10: replace the authenticator, then log in with the new one', async ({ page }) => {
  const problems = watchConsole(page);
  await start(page);
  const s = server as ShellServer;
  await page.goto(`${s.url}/settings/security`);
  await page.getByRole('button', { name: 'Replace the authenticator' }).click();
  await stepUp(page, s);
  await expect(page.getByTestId('totp-qr')).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').textContent()) ?? '';
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  await expectAccessible(page, 'authenticator replacement');
  await page.getByLabel('Code from the new authenticator').fill(totp(secret, new Date()));
  await page.getByRole('button', { name: 'Use the new authenticator' }).click();
  await expect(page.getByText('Authenticator replaced.', { exact: false })).toBeVisible();

  // The new app's next code logs in; the confirmation used the current one.
  await page.goto(`${s.url}/settings/sessions`);
  await page.getByRole('button', { name: 'End this session' }).click();
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(SHELL_PASSWORD);
  await page.getByLabel('Authenticator code').fill(totp(secret, new Date(Date.now() + 30_000)));
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByTestId('balance-spendable')).toBeVisible();
  expect(unexpected(problems)).toEqual([]);
});

async function secondLogin(browser: Browser, s: ShellServer): Promise<Page> {
  const context = await browser.newContext();
  const other = await context.newPage();
  await other.goto(`${s.url}/login`);
  await other.getByLabel('Password', { exact: true }).fill(SHELL_PASSWORD);
  await other.getByLabel('Authenticator code').fill(nextCode(s));
  await other.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(other.getByTestId('balance-spendable')).toBeVisible();
  return other;
}

test('U10: end another session, then log out everywhere', async ({ page, browser }) => {
  const problems = watchConsole(page);
  await start(page);
  const s = server as ShellServer;
  const other = await secondLogin(browser, s);
  await page.goto(`${s.url}/settings/sessions`);
  // This session, the other browser's, and the one the test setup left open.
  const rows = page.getByTestId('session-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'This session' })).toHaveCount(1);
  await expectAccessible(page, 'sessions settings');
  for (const left of [2, 1]) {
    await rows.filter({ hasNotText: 'This session' }).first().getByRole('button', { name: 'End session' }).click();
    await expect(page.getByTestId('destructive-confirm')).toContainText('logged out at once');
    await page.getByTestId('destructive-confirm-button').click();
    await expect(rows).toHaveCount(left);
  }
  await expect(page.getByText('2 ended sessions')).toBeVisible();
  // The other browser finds its session gone at its next request.
  await other.reload();
  await expect(other.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await other.context().close();

  await page.getByRole('button', { name: 'Log out everywhere' }).click();
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  expect(unexpected(problems)).toEqual([]);
});

test('U10: known devices and session timeouts after one step-up', async ({ page }) => {
  const problems = watchConsole(page);
  await start(page);
  const s = server as ShellServer;
  await page.goto(`${s.url}/settings/sessions`);
  const unlock = page.getByRole('button', { name: 'Confirm it is you to show' });
  await expect(unlock).toHaveCount(2);
  await unlock.first().click();
  await stepUp(page, s);
  await expect(page.getByTestId('devices').or(page.getByTestId('devices-empty'))).toBeVisible();
  // The grant is still live: the timeouts open without asking again.
  await page.getByRole('button', { name: 'Confirm it is you to show' }).click();
  await expect(page.getByTestId('step-up')).toBeHidden();
  const idle = page.getByLabel('Log out after this long without activity', { exact: true });
  await expect(idle).toHaveValue('1');
  await expect(page.getByLabel('Unit of Log out after this long without activity')).toHaveValue('hours');
  await expect(page.getByLabel('Log out after this long in any case', { exact: true })).toHaveValue('7');
  await idle.fill('2');
  await page.getByLabel('Unit of Log out after this long without activity').selectOption('days');
  await page.getByLabel('Log out after this long in any case', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save timeouts' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'cannot be longer' })).toBeVisible();
  await idle.fill('30');
  await page.getByLabel('Unit of Log out after this long without activity').selectOption('minutes');
  await page.getByLabel('Log out after this long in any case', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Save timeouts' }).click();
  await expect(page.getByText('Timeouts saved.', { exact: false })).toBeVisible();
  await expectAccessible(page, 'sessions settings unlocked');
  expect(unexpected(problems)).toEqual([]);
});

const BLOCK = JSON.stringify({
  version: 1,
  implementation: 'cln',
  accessLevel: 'standard',
  viewRune: testRune('read'),
  spendRune: testRune('spend'),
});

test('nodes: add with the limits step, recheck, replace and remove', async ({ page }) => {
  const problems = watchConsole(page);
  const ids = await start(page, { extraNodes: [{ name: 'dave', chain: 'blake2b' }] });
  const s = server as ShellServer;
  await page.goto(`${s.url}/settings/nodes`);
  await expect(page.getByTestId('settings-nodes').getByRole('listitem')).toHaveCount(3);
  await page.getByRole('button', { name: 'Add a node' }).click();
  await expect(page).toHaveURL(/\/settings\/nodes\?add=true$/);
  await page.getByRole('button', { name: 'Show the setup command' }).click();
  await expect(page.getByTestId('setup-command')).toContainText('lightning-cli');

  const form = page.getByTestId('node-form-add');
  // An admin credential needs the acknowledgement.
  await form.getByRole('radio', { name: 'Enter the runes one by one' }).check();
  await form.getByLabel('Access level').selectOption('admin');
  await expect(form.getByTestId('admin-warning')).toBeVisible();
  await form.getByRole('button', { name: 'Connect and add the node' }).click();
  await expect(form.getByRole('alert')).toContainText('risk of an admin credential');
  await form.getByRole('radio', { name: 'Paste the block from the setup command' }).check();
  await form.getByLabel('Name in this app').fill('dave');
  await form.getByLabel('Network').selectOption('regtest');
  await form.getByLabel('clnrest address').fill('https://dave.fake.invalid');
  await form.getByLabel("Node's certificate authority (PEM)").fill(FAKE_CA);
  await form.getByLabel('Credential block').fill(BLOCK);
  await expectAccessible(page, 'add node form');
  await form.getByRole('button', { name: 'Connect and add the node' }).click();
  await stepUp(page, s);
  // The node can spend and its identity has no limits yet: the limits step appears, then the same request again.
  await expect(form.getByRole('alert')).toContainText('has no limits yet');
  await form.getByTestId('limit-max24h').fill('100000');
  await form.getByRole('button', { name: 'Save the limits and connect' }).click();
  await expect(page.getByText('dave added.')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/nodes$/);
  await expect(page.getByTestId('settings-nodes').getByRole('listitem')).toHaveCount(4);

  const dave = (await nodeIds(page)).dave;
  await page.getByRole('link', { name: 'dave', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/nodes/${dave}$`));
  await expect(page.getByTestId('credential-status')).toContainText('Working');
  await page.getByRole('button', { name: 'Check the credentials again' }).click();
  await expect(page.getByText('Credentials checked.')).toBeVisible();
  await expectAccessible(page, 'node settings');
  await page.goto(`${s.url}/settings/nodes/${dave}/limits`);
  await expect(page.getByTestId('limit-max24h')).toHaveValue('100000');

  // Replace alice's connection: chain and network stay; the whole connection is entered again.
  await page.goto(`${s.url}/settings/nodes/${ids.alice}`);
  await page.getByRole('button', { name: 'Replace the connection' }).click();
  const replace = page.getByTestId('node-form-replace');
  await expect(replace.getByLabel('Chain')).toBeDisabled();
  await expect(replace.getByLabel('Name in this app')).toHaveValue('alice');
  await replace.getByLabel('clnrest address').fill('https://alice.fake.invalid');
  await replace.getByLabel("Node's certificate authority (PEM)").fill(FAKE_CA);
  await replace.getByLabel('Credential block').fill(BLOCK);
  await replace.getByRole('button', { name: 'Check and replace' }).click();
  // alice was added without limits (this server has no spending policy), so the replacement asks for them too.
  await expect(replace.getByRole('alert')).toContainText('has no limits yet');
  await replace.getByRole('button', { name: 'Save the limits and connect' }).click();
  await expect(page.getByText('Connection replaced.')).toBeVisible();

  // Remove dave: a destructive confirmation, then back to the list.
  await page.goto(`${s.url}/settings/nodes/${dave}`);
  await page.getByRole('button', { name: 'Remove dave' }).click();
  await expect(page.getByTestId('destructive-confirm')).toContainText('funds are not touched');
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page).toHaveURL(/\/settings\/nodes$/);
  await expect(page.getByTestId('settings-nodes').getByRole('listitem')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'dave', exact: true })).toHaveCount(0);
  expect(unexpected(problems)).toEqual([]);
});

test('U9: spending limits are checked, saved behind a step-up and kept', async ({ page }) => {
  const problems = watchConsole(page);
  const ids = await start(page, { spending: true });
  const s = server as ShellServer;
  await page.goto(`${s.url}/settings/nodes/${ids.alice}/limits`);
  await expect(page.getByRole('heading', { name: 'Spending limits: alice' })).toBeVisible();
  await expect(page.getByTestId('limits-usage')).toContainText('No 24-hour cap');
  await expectAccessible(page, 'limits settings');
  await page.getByTestId('limit-maxPerPayment').fill('300');
  await page.getByTestId('limit-max24h').fill('200');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'cannot be above the 24-hour cap' })).toBeVisible();
  await page.getByTestId('limit-max24h').fill('1.000');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Some values are not valid' })).toBeVisible();
  await page.getByTestId('limit-max24h').fill('1000');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await stepUp(page, s);
  await expect(page.getByText('Limits saved.')).toBeVisible();
  await expect(page.getByTestId('limits-remaining')).toContainText('1,000 sat');
  await page.reload();
  await expect(page.getByTestId('limit-maxPerPayment')).toHaveValue('300');
  await expect(page.getByTestId('limit-max24h')).toHaveValue('1000');
  expect(unexpected(problems)).toEqual([]);
});

test('unresolved spends: empty, listed with the warning, resolved after a step-up, broadcast refused', async ({
  page,
}) => {
  const problems = watchConsole(page);
  const ids = await start(page, { spending: true });
  const s = server as ShellServer;
  await page.goto(`${s.url}/settings/spends`);
  await expect(page.getByTestId('empty-state')).toContainText('Nothing unresolved');

  // A fake node cannot be made to leave a spend unknown from the browser, so the list and the resolve answers are
  // the server's shapes served by the test; the step-up in between is the real one.
  const intentId = '0a6c5f1e-5d1b-4a8e-9f3e-2b1c0d9e8f7a';
  const txid = 'ab'.repeat(32);
  const warning = 'Only mark a spend as failed when you are sure no funds left the node.';
  let resolves = 0;
  await page.route(`**/api/v1/nodes/${ids.alice}/spends/unresolved`, (route) =>
    route.fulfill({
      json: {
        warning,
        items: [
          {
            intentId,
            type: 'onchain',
            amount: '10000000',
            cost: '10500000',
            destination: 'bcrt1qexample',
            txid,
            reason: 'interrupted',
            createdAt: '2026-10-17T10:00:00.000Z',
            updatedAt: '2026-10-17T10:00:00.000Z',
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/nodes/${ids.alice}/spends/${intentId}/resolve`, (route) => {
    resolves++;
    const body = route.request().postDataJSON() as { outcome: string };
    if (resolves === 1)
      return route.fulfill({
        status: 403,
        json: { error: { code: 'step_up_required', message: 'Please re-authenticate.', requestId: 'r-1' } },
      });
    if (body.outcome === 'failed')
      return route.fulfill({
        status: 400,
        json: {
          error: {
            code: 'validation_failed',
            message: 'The node wallet lists this transaction.',
            requestId: 'r-2',
            details: { reason: 'broadcast' },
          },
        },
      });
    return route.fulfill({ json: { intentId, state: 'succeeded' } });
  });
  await page.goto(`${s.url}/settings`);
  await expect(page.getByTestId('unresolved-count')).toHaveText('1 unresolved');
  await page.goto(`${s.url}/settings/spends?node=${ids.alice}`);
  const spend = page.getByTestId('unresolved-spend');
  await expect(spend).toContainText('On-chain send');
  await expect(spend).toContainText('The server stopped while the node was working on it.');
  await expect(page.getByTestId('unresolved-warning')).toHaveText(warning);
  await expectAccessible(page, 'unresolved spends');

  await spend.getByRole('button', { name: 'Mark as not sent' }).click();
  await expect(page.getByTestId('destructive-confirm')).toContainText(warning);
  await page.getByTestId('destructive-confirm-button').click();
  await stepUp(page, s);
  await expect(page.getByRole('alert').filter({ hasText: 'it was sent' })).toBeVisible();
  await spend.getByRole('button', { name: 'Mark as sent' }).click();
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page.getByText('Marked as sent.')).toBeVisible();
  expect(resolves).toBe(3);
  expect(unexpected(problems)).toEqual([]);
});
