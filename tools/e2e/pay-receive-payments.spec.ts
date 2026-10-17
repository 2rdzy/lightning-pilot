// WP18 stories in the browser, through the real server with the fake nodes alice and bob (BLAKE2b) and carol
// (SHA256d): U7 receive with a live "paid" update, U8 the universal pay input with preview and confirm, and the
// payments history. Also the 2026-10-13 code review's cases for the screens that move money: a lost reply retried
// with the same key, the unknown outcome, switching node during a request, fractional-sat costs, and browser back
// after logout.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './axe.ts';
import { logIn, SHELL_PASSWORD, startShellServer, watchConsole, type ShellServer } from './shell-server.ts';

let server: ShellServer;
test.beforeEach(async () => {
  server = await startShellServer({ spending: true, live: true });
});
test.afterEach(async () => {
  await server.close();
});

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

// Logs in and returns the app paths of the three nodes, by name.
async function start(page: Page): Promise<Record<'alice' | 'bob' | 'carol', string>> {
  await logIn(page, server);
  const { items } = (await (await page.request.get(`${server.url}/api/v1/nodes`)).json()) as {
    items: { id: string; name: 'alice' | 'bob' | 'carol' }[];
  };
  return Object.fromEntries(items.map((n) => [n.name, `${server.url}/n/${n.id}`])) as Record<
    'alice' | 'bob' | 'carol',
    string
  >;
}

// A POST as the logged-in browser session (CSRF token from the session, Origin of the app).
async function post(page: Page, path: string, body: unknown) {
  const { csrfToken } = (await (await page.request.get(`${server.url}/api/v1/auth/session`)).json()) as {
    csrfToken: string;
  };
  const response = await page.request.post(`${server.url}${path}`, {
    data: body,
    headers: { 'x-csrf-token': csrfToken, origin: server.url },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as { paymentHash: string; bolt11: string };
}
const invoiceOf = (page: Page, node: string, amountMsat: string, description = '') =>
  post(page, `/api/v1/nodes/${node.split('/n/')[1]}/invoices`, { amount: amountMsat, description });

// Previews `request` on the pay screen of `node`.
async function preview(page: Page, node: string, request: string) {
  await page.goto(`${node}/pay`);
  await page.getByLabel('Payment request', { exact: true }).fill(request);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByTestId('preview')).toBeVisible();
}
// Confirms, with the password when the server asks for a step-up.
async function confirm(page: Page) {
  await page.getByRole('button', { name: /^Pay up to [0-9,.]+ sat$/ }).click();
  const stepUp = page.getByTestId('step-up');
  const outcome = page.getByTestId('payment-outcome');
  await expect(stepUp.or(outcome)).toBeVisible();
  if (await stepUp.isVisible()) {
    await stepUp.getByLabel('Password', { exact: true }).fill(SHELL_PASSWORD);
    await stepUp.getByRole('button', { name: 'Confirm', exact: true }).click();
  }
}

test('U7: an invoice opens its own page with the QR code and turns to Paid live, without a reload', async ({
  page,
  context,
}) => {
  const problems = watchConsole(page);
  const nodes = await start(page);
  await page.goto(`${nodes.bob}/receive`);
  await page.getByLabel('Amount (sat)').fill('2500');
  await expect(page.getByText('Invoice for 2,500 sat')).toBeVisible();
  await page.getByLabel('Description (shown to the payer)').fill('U7 coffee');
  await page.getByLabel('Valid for').selectOption({ label: '24 hours' });
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f]{64}$/);
  await expect(page.getByText('Invoice created')).toBeVisible();
  await expect(page.getByTestId('invoice-status')).toHaveAttribute('data-state', 'unpaid');
  await expect(page.getByRole('img', { name: 'QR code of the invoice' })).toBeVisible();
  await expect(page.getByTestId('invoice-amount')).toHaveText('2,500 sat');
  const bolt11 = (await page.getByTestId('bolt11').textContent()) ?? '';
  // A refresh keeps the invoice.
  await page.reload();
  await expect(page.getByTestId('bolt11')).toHaveText(bolt11);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `invoice ${colorScheme}`);
  }

  // Alice pays it in another tab; this one follows the node's events.
  const payer = await context.newPage();
  await preview(payer, nodes.alice, bolt11);
  await expect(payer.getByTestId('preview-amount')).toHaveText('2,500 sat');
  await expect(payer.getByText('U7 coffee')).toBeVisible();
  await confirm(payer);
  await expect(payer.getByTestId('payment-outcome')).toHaveAttribute('data-state', 'succeeded');
  await expect(payer.getByTestId('payment-preimage')).toBeVisible();
  await expect(page.getByTestId('invoice-status')).toHaveAttribute('data-state', 'paid', { timeout: 15_000 });
  await expect(page.getByTestId('invoice-received')).toHaveText('2,500 sat');
  await expect(page.getByRole('img', { name: 'QR code of the invoice' })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('U8: a bitcoin: link with an invoice previews the invoice, keeps its texts, and leaves the history', async ({
  page,
}) => {
  const nodes = await start(page);
  const { bolt11 } = await invoiceOf(page, nodes.bob, '1000000', 'Order 42');
  const uri = `bitcoin:?lightning=${bolt11}&label=Shop&message=Thanks`;
  await page.goto(`${nodes.alice}/pay?request=${encodeURIComponent(uri)}`);
  await expect(page).toHaveURL(new RegExp(`${nodes.alice}/pay$`));
  await expect(page.getByTestId('from-link')).toBeVisible();
  await expect(page.getByLabel('Payment request', { exact: true })).toHaveValue(uri);
  // A link never acts by itself: nothing is previewed until asked.
  await expect(page.getByTestId('preview')).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const panel = page.getByTestId('preview');
  await expect(panel.getByTestId('preview-amount')).toHaveText('1,000 sat');
  await expect(panel.getByTestId('chain-badge')).toHaveText('BLAKE2b ✓');
  await expect(panel.getByText('Shop', { exact: true })).toBeVisible();
  await expect(panel.getByText('Thanks', { exact: true })).toBeVisible();
  await expect(panel.getByText('Order 42', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('preview-remaining')).toBeVisible();
  await expect(panel.getByTestId('preview-payee')).toBeVisible();
  await expectAccessible(page, 'pay preview');
  await confirm(page);
  await expect(page.getByTestId('payment-outcome')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByText('Paid 1,000 sat')).toBeVisible();
});

test('U8: what is not a Lightning invoice is pointed elsewhere, and refusals give their reason', async ({ page }) => {
  const nodes = await start(page);
  await page.goto(`${nodes.alice}/pay`);
  const field = page.getByLabel('Payment request', { exact: true });
  const handoff = page.getByTestId('pay-handoff');
  const send = () => page.getByRole('button', { name: 'Preview', exact: true }).click();

  await field.fill('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
  await send();
  await expect(handoff).toContainText('This is an on-chain address.');

  const pubkey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  await field.fill(`${pubkey}@127.0.0.1:9735`);
  await send();
  await expect(handoff).toContainText('This is a node address');
  await expect(handoff.getByRole('link', { name: 'Connect to this peer' })).toHaveAttribute(
    'href',
    new RegExp(`/peers/connect\\?peer=${pubkey}$`),
  );

  await field.fill('satoshi@example.com');
  await send();
  await expect(handoff).toContainText('is not supported in this release');

  await field.fill('hello');
  await send();
  await expect(handoff).toContainText('not a payment request this app recognises');

  // carol is on SHA256d: her invoice is for the other chain. The server refuses it with that reason.
  const stock = await invoiceOf(page, nodes.carol, '5000');
  await field.fill(stock.bolt11);
  await send();
  await expect(
    page.getByText('This invoice is for the other chain. Paying it from this node is refused.'),
  ).toBeVisible();
  await expect(page.getByTestId('preview')).toHaveCount(0);
  await expectAccessible(page, 'pay refusal');
});

test('U8: a QR code in a photo fills the request field', async ({ page }) => {
  const nodes = await start(page);
  const { paymentHash, bolt11 } = await invoiceOf(page, nodes.bob, '3000');
  await page.goto(`${nodes.bob}/invoices/${paymentHash}`);
  const picture = await page.getByRole('img', { name: 'QR code of the invoice' }).screenshot();
  await page.goto(`${nodes.alice}/pay`);
  await page
    .getByTestId('qr-image-input')
    .setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await expect(page.getByText('No QR code was found in that picture.', { exact: false })).toBeVisible();
  await page.getByTestId('qr-image-input').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: picture });
  // The QR code holds the invoice in upper case (denser); the decoder accepts either case.
  await expect(page.getByLabel('Payment request', { exact: true })).toHaveValue(bolt11.toUpperCase());
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByTestId('preview-amount')).toHaveText('3 sat');
});

test('a lost execute reply retries the same body and key; the payment is made once', async ({ page }) => {
  const nodes = await start(page);
  const { bolt11 } = await invoiceOf(page, nodes.bob, '4000');
  const keys: string[] = [],
    bodies: unknown[] = [];
  await page.route('**/payments/execute', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    bodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (keys.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await preview(page, nodes.alice, bolt11);
  await page.getByRole('button', { name: /^Pay up to [0-9,.]+ sat$/ }).click();
  await expect(page.getByText('The server could not be reached. Check the connection and try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change the request', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /^Pay up to [0-9,.]+ sat$/ }).click();
  await expect(page.getByTestId('payment-outcome')).toHaveAttribute('data-state', 'succeeded');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(bodies[1]).toEqual(bodies[0]);
  const { items } = (await (
    await page.request.get(`${nodes.alice.replace('/n/', '/api/v1/nodes/')}/payments`)
  ).json()) as { items: unknown[] };
  expect(items).toHaveLength(1);
});

test('an unknown outcome stays unresolved, links to the node record, and "Check again" keeps the key', async ({
  page,
}) => {
  const nodes = await start(page);
  const { bolt11, paymentHash } = await invoiceOf(page, nodes.bob, '6000');
  const keys: string[] = [];
  await page.route('**/payments/execute', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (keys.length === 1)
      await route.fulfill({
        status: 200,
        json: { intentId: '11111111-1111-4111-8111-111111111111', state: 'unknown', paymentHash, amount: '6000' },
      });
    else await route.continue();
  });
  await preview(page, nodes.alice, bolt11);
  await confirm(page);
  const outcome = page.getByTestId('payment-outcome');
  await expect(outcome).toHaveAttribute('data-state', 'unknown');
  await expect(page.getByText('Do not pay this invoice again.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('payment-detail-link')).toHaveAttribute(
    'href',
    new RegExp(`/payments/${paymentHash}$`),
  );
  await expectAccessible(page, 'unknown outcome');
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(outcome).toHaveAttribute('data-state', 'succeeded');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await page.getByTestId('payment-detail-link').click();
  await expect(page.getByTestId('payment-detail')).toHaveAttribute('data-state', 'succeeded');
});

test('switching node during a preview drops it; fractional-sat costs are shown exactly', async ({ page }) => {
  const nodes = await start(page);
  const { bolt11 } = await invoiceOf(page, nodes.bob, '1500');
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/payments/preview', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${nodes.alice}/pay`);
  await page.getByLabel('Payment request', { exact: true }).fill(bolt11);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByTestId('node-select').selectOption({ label: 'carol' });
  await expect(page).toHaveURL(new RegExp(`${nodes.carol}`));
  await page.goto(`${nodes.carol}/pay`);
  release();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('preview')).toHaveCount(0);
  await expect(page.getByLabel('Payment request', { exact: true })).toHaveValue('');
  await page.unroute('**/payments/preview');

  await preview(page, nodes.alice, bolt11);
  await expect(page.getByTestId('preview-amount')).toHaveText('1.500 sat');
  await expect(page.getByRole('button', { name: /^Pay up to [0-9,]+\.[0-9]{3} sat$/ })).toBeVisible();
});

test('history: sent and received tabs, filters in the URL, details, unknown hashes', async ({ page }) => {
  const nodes = await start(page);
  for (const [amount, description] of [
    ['7000', 'first'],
    ['8000', 'second'],
  ] as const) {
    const { bolt11 } = await invoiceOf(page, nodes.bob, amount, description);
    await preview(page, nodes.alice, bolt11);
    await confirm(page);
    await expect(page.getByTestId('payment-outcome')).toHaveAttribute('data-state', 'succeeded');
  }
  await invoiceOf(page, nodes.bob, '9000', 'still open');

  await page.goto(nodes.alice);
  if (await nav(page).getByRole('button', { name: 'More' }).isVisible())
    await nav(page).getByRole('button', { name: 'More' }).click();
  await page.getByRole('link', { name: 'Payments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  // Newest first: the 8 sat payment above the 7 sat one.
  const amounts = page.getByText(/^[78] sat$/).filter({ visible: true });
  await expect(amounts).toHaveText(['8 sat', '7 sat']);
  await expectAccessible(page, 'payments sent');

  await page.goto(`${nodes.bob}/payments?tab=received&status=paid`);
  await expect(page.getByText(/^(7|8|9) sat$/).filter({ visible: true })).toHaveText(['8 sat', '7 sat']);
  await page.reload();
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('paid');
  await page.getByLabel('Status', { exact: true }).selectOption('unpaid');
  await expect(page).toHaveURL(/status=unpaid/);
  await expect(page.getByText(/^(7|8|9) sat$/).filter({ visible: true })).toHaveText(['9 sat']);
  // A status of the other tab means "all".
  await page.goto(`${nodes.bob}/payments?tab=received&status=failed&sort=amount`);
  await expect(page.getByText(/^(7|8|9) sat$/).filter({ visible: true })).toHaveText(['7 sat', '8 sat', '9 sat']);
  await page.getByLabel('Filter (hash, payee, text)').fill('second');
  await expect(page.getByText(/^(7|8|9) sat$/).filter({ visible: true })).toHaveText(['8 sat']);
  await expectAccessible(page, 'payments received');
  await page
    .getByRole('link', { name: /^[0-9a-f]{8}…[0-9a-f]{8}$/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByTestId('invoice-status')).toHaveAttribute('data-state', 'paid');

  await page.goto(`${nodes.alice}/payments/${'ab'.repeat(32)}`);
  await expect(page.getByTestId('history-missing')).toContainText('This node has no payment with this hash.');
  await page.goto(`${nodes.alice}/invoices/not-a-hash`);
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
});

test('receive on-chain: a new address only on request, naming its chain; refresh makes none', async ({ page }) => {
  const nodes = await start(page);
  let calls = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/onchain/address')) calls++;
  });
  await page.goto(`${nodes.alice}/receive?tab=onchain`);
  await expect(page.getByRole('button', { name: 'New address', exact: true })).toBeVisible();
  expect(calls).toBe(0);
  await page.getByLabel('Address type').selectOption('p2tr');
  await page.getByRole('button', { name: 'New address', exact: true }).click();
  await expect(page.getByTestId('new-address')).toContainText('Receives on Bitcoin BLAKE2b (regtest) only.');
  await expect(page.getByTestId('address')).toHaveText(/^bcrt1p[0-9a-z]+$/);
  await expect(page.getByRole('img', { name: 'QR code of the address' })).toBeVisible();
  await expectAccessible(page, 'receive on-chain');
  await page.reload();
  await expect(page.getByTestId('new-address')).toHaveCount(0);
  expect(calls).toBe(1);
  await page.goto(`${nodes.carol}/receive?tab=onchain`);
  await page.getByRole('button', { name: 'New address', exact: true }).click();
  await expect(page.getByTestId('new-address')).toContainText('Receives on Bitcoin SHA256d (regtest) only.');
});

test('browser back after logout shows no payment data', async ({ page }) => {
  const nodes = await start(page);
  const { paymentHash } = await invoiceOf(page, nodes.bob, '1000', 'private');
  await page.goto(`${nodes.bob}/invoices/${paymentHash}`);
  await expect(page.getByTestId('invoice-status')).toBeVisible();
  if (await nav(page).getByRole('button', { name: 'More' }).isVisible())
    await nav(page).getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByTestId('invoice-status')).toHaveCount(0);
  await expect(page.getByText('private')).toHaveCount(0);
});
