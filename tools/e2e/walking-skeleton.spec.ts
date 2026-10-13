// The walking skeleton in the browser (build plan WP02), at desktop and phone size, against the built web app served
// by the real server: setup → login → dashboard balance → invoice on bob with QR → alice pays it through a link
// (prefill only, removed from history, preview, confirm) → balance changes → reload keeps the session → logout →
// a deep link after logout returns there after login. No console error (a CSP violation is one) and no secret in
// the server log.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { LOG_DIR } from './global-setup.ts';

const PASSWORD = `E2e-${Math.random().toString(36).slice(2, 10)}-Pw9!`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const AMOUNT_SAT = 1000;

// Navigation: the left bar on a desktop, the bottom tab bar on a phone; the same accessible names.
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

// Runs in the browser; tools/ is type-checked without the DOM library, hence the cast.
const historyLength = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { history: { length: number } }).history.length);

async function spendable(page: Page): Promise<string> {
  const text = await page.getByTestId('balance-spendable').textContent();
  if (!text) throw new Error('no spendable balance shown');
  return text;
}

test('setup, login, receive, pay and log out in the browser', async ({ page }, testInfo) => {
  const problems: string[] = [];
  page.on('console', (msg) => {
    // The browser logs every 401 it receives; those are expected here (the session probe while logged out, the
    // wrong password). Anything else, a CSP violation included, is a problem.
    if (msg.type() === 'error' && !/status of 401 \(Unauthorized\)/.test(msg.text())) problems.push(msg.text());
  });
  page.on('pageerror', (err) => problems.push(err.message));

  const token = process.env[`E2E_SETUP_TOKEN_${testInfo.project.name.toUpperCase()}`];
  if (!token) throw new Error('no setup token from global setup');

  // Fresh server: every route leads to setup.
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Setup token').fill(token);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(`${PASSWORD}x`);
  await page.getByRole('button', { name: 'Create owner' }).click();
  await expect(page.getByText('The passwords are not the same.')).toBeVisible();
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner' }).click();

  // Login; a wrong password first shows the translated error.
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Password').fill('Wrong-password-1!');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText('The password is not correct.')).toBeVisible();
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();

  // "/" opens the first node's dashboard: alice, with her chain and balances.
  await expect(page).toHaveURL(new RegExp(`/n/${UUID.source}$`));
  const aliceUrl = new URL(page.url()).pathname;
  await expect(page.getByTestId('node-select')).toHaveValue(aliceUrl.split('/')[2] ?? '');
  await expect(page.getByTestId('chain-badge')).toHaveText(/BLAKE2b ✓|SHA256d ✓/);
  await expect(page.getByTestId('balance-spendable')).toHaveText(/^[0-9.,'\s\u00a0\u202f]+ sat$/);
  const before = await spendable(page);

  // Bob makes an invoice; it is shown as QR code and text.
  await page.getByTestId('node-select').selectOption({ label: 'bob' });
  await expect(page).not.toHaveURL(aliceUrl);
  await nav(page).getByRole('link', { name: 'Receive' }).click();
  await expect(page).toHaveURL(/\/receive$/);
  await page.getByLabel('Amount (sat)').fill(String(AMOUNT_SAT));
  await expect(page.getByText('Invoice for 1,000 sat')).toBeVisible();
  await page.getByLabel('Description (shown to the payer)').fill('e2e walking skeleton');
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page.getByText('Invoice created')).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR code of the invoice' })).toBeVisible();
  await expect(page.getByTestId('invoice-amount')).toHaveText('1,000 sat');
  const bolt11 = (await page.getByTestId('bolt11').textContent()) ?? '';
  expect(bolt11).toMatch(/^lnbcrt[0-9a-z]+$/);

  // Alice opens a payment link: it only prefills, and leaves the browser history at once.
  await page.goto(`${aliceUrl}/pay?request=${bolt11}`);
  await expect(page).toHaveURL(new RegExp(`${aliceUrl}/pay$`));
  await expect(page.getByTestId('from-link')).toBeVisible();
  await expect(page.getByLabel('Payment request (BOLT11 invoice)')).toHaveValue(bolt11);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('preview-amount')).toHaveText('1,000 sat');
  await expect(page.getByTestId('preview').getByTestId('chain-badge')).toBeVisible();
  await page.getByRole('button', { name: 'Pay 1,000 sat' }).click();
  await expect(page.getByTestId('payment-outcome')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByText('Paid 1,000 sat')).toBeVisible();

  // The balance on the dashboard has changed.
  await nav(page).getByRole('link', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(new RegExp(`${aliceUrl}/?$`));
  await expect.poll(() => spendable(page), { timeout: 30_000 }).not.toBe(before);

  // A reload keeps the session (the CSRF token is fetched again).
  await page.reload();
  await expect(page.getByTestId('balance-spendable')).toBeVisible();

  // Logout; a deep link then goes through login and comes back.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto(`${aliceUrl}/receive`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(new RegExp(`${aliceUrl}/receive$`));

  // A payment link opened while logged out goes through login; afterwards neither the link nor the login entry
  // with it in ?next= stays in the browser history.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto(`${aliceUrl}/pay?request=${bolt11}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  const entries = await historyLength(page);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(new RegExp(`${aliceUrl}/pay$`));
  await expect(page.getByTestId('from-link')).toBeVisible();
  await expect(page.getByLabel('Payment request (BOLT11 invoice)')).toHaveValue(bolt11);
  // Each step replaced the entry before it: no new history entry holds the request.
  expect(await historyLength(page)).toBe(entries);

  // Unknown routes show "not found" with a way back, never a crash.
  await page.goto('/n/not-a-node/pay');
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();

  expect(problems, problems.join('\n')).toEqual([]);
  const log = readFileSync(join(LOG_DIR, `${testInfo.project.name}.log`), 'utf8');
  expect(log).not.toContain(PASSWORD);
  expect(log).not.toContain('fake-spend-');
  expect(log).not.toContain('fake-view-');
});
