// WP19 stories in the browser, through the real server with the fake nodes alice and bob (BLAKE2b) and carol
// (SHA256d): U6 on-chain send with a fee preview, and the on-chain wallet (balance, coins, transactions, CSV, detail).
// A fake node starts with one confirmed coin of 500,000 sat; its transactions cost 68 vB per input and 43 vB per output
// (packages/adapter-kit fake.ts). The test policy caps the fee rate at 10 sat/vB and the fee at 5 % of the amount, so
// the node's 12 sat/vB "Normal" estimate is refused at preview, and a 1,000 sat send fails at execute (fee 330 sat
// above its 50 sat maximum) while a 10,000 sat send at 2 sat/vB goes through.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './axe.ts';
import { logIn, SHELL_PASSWORD, startShellServer, watchConsole, type ShellServer } from './shell-server.ts';

let server: ShellServer | undefined;
test.afterEach(async () => {
  await server?.close();
  server = undefined;
});

type Nodes = Record<'alice' | 'bob' | 'carol', { path: string; id: string }>;

// Starts a server, logs in and returns the nodes by name.
async function start(page: Page, options: Parameters<typeof startShellServer>[0] = { spending: true }) {
  server = await startShellServer(options);
  await logIn(page, server);
  const { items } = (await (await page.request.get(`${server.url}/api/v1/nodes`)).json()) as {
    items: { id: string; name: 'alice' | 'bob' | 'carol' }[];
  };
  return Object.fromEntries(
    items.map((n) => [n.name, { id: n.id, path: `${(server as ShellServer).url}/n/${n.id}` }]),
  ) as Nodes;
}

// A new address of `node`'s wallet, through the API as the logged-in browser session.
async function addressOf(page: Page, node: { id: string }): Promise<string> {
  const url = (server as ShellServer).url;
  const { csrfToken } = (await (await page.request.get(`${url}/api/v1/auth/session`)).json()) as { csrfToken: string };
  const response = await page.request.post(`${url}/api/v1/nodes/${node.id}/onchain/address`, {
    data: {},
    headers: { 'x-csrf-token': csrfToken, origin: url },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { address: string }).address;
}

// Fills the send form of `node` and previews it.
async function previewSend(page: Page, node: { path: string }, address: string, sats: string, fee = 'Slow') {
  await page.goto(`${node.path}/onchain/send`);
  await page.getByLabel('Address', { exact: true }).fill(address);
  await page.getByLabel('Amount (sat)', { exact: true }).fill(sats);
  await page.getByRole('radio', { name: new RegExp(`^${fee}`) }).check();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
}
const sendButton = (page: Page) => page.getByRole('button', { name: /^Send [0-9.,]+ XBT on Bitcoin BLAKE2b$/ });
// Confirms in the preview and in the second confirmation.
async function confirmSend(page: Page) {
  await sendButton(page).first().click();
  await expect(page.getByTestId('onchain-confirm')).toBeVisible();
  await page.getByTestId('onchain-confirm-button').click();
}

test('U6: the wallet shows balance, coins and transactions; CSV holds the loaded rows', async ({ page }) => {
  const problems = watchConsole(page);
  const nodes = await start(page);
  await page.goto(`${nodes.alice.path}/onchain`);
  await expect(page.getByRole('heading', { name: 'On-chain wallet', level: 1 })).toBeVisible();
  if (test.info().project.name === 'phone')
    await expect(page.getByText('This screen belongs to the Advanced view.')).toBeVisible();
  await expect(page.getByTestId('onchain-confirmed')).toHaveText('500,000 sat');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `on-chain wallet ${colorScheme}`);
  }

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('lightning-pilot-alice-blake2b-onchain.csv');
  const csv = readFileSync((await file.path()) as string, 'utf8').split('\r\n');
  expect(csv[0]).toBe('txid,kind,direction,amount_sat,fee_sat,block_height,confirmations,label');
  expect(csv[1]).toMatch(/^[0-9a-f]{64},receive,in,500000,,[0-9]+,11,$/);

  // The kind filter lives in the URL and survives a reload.
  await page.getByLabel('Kind', { exact: true }).selectOption('send');
  await expect(page).toHaveURL(/kind=send/);
  await page.reload();
  await expect(page.getByText('No transactions yet').filter({ visible: true })).toBeVisible();

  // A row opens its detail page, with the coin it created and no explorer link on regtest.
  await page.getByLabel('Kind', { exact: true }).selectOption('all');
  await page
    .getByRole('link', { name: /^[0-9a-f]{8}…[0-9a-f]{8}$/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/onchain\/tx\/[0-9a-f]{64}$/);
  await expect(page.getByRole('heading', { name: 'Transaction', level: 1 })).toBeVisible();
  await expect(page.getByTestId('onchain-confirmations')).toHaveText('11');
  await expect(page.getByTestId('explorer-link')).toHaveCount(0);
  await expectAccessible(page, 'transaction detail');
  expect(problems).toEqual([]);
});

test('U6: send with a fee preset, a second confirmation naming coin and chain, then the transaction', async ({
  page,
}) => {
  const problems = watchConsole(page);
  const nodes = await start(page);
  const to = await addressOf(page, nodes.bob);
  await page.goto(`${nodes.alice.path}/onchain/send`);
  // The presets show the node's own estimates.
  await expect(page.getByRole('radio', { name: 'Fast · 20 sat/vB' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Normal · 12 sat/vB' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Slow · 2 sat/vB' })).toBeVisible();
  await expectAccessible(page, 'send form');
  await previewSend(page, nodes.alice, to, '10000');
  await expect(page.getByTestId('preview')).toBeVisible();
  await expect(page.getByTestId('preview-address')).toHaveText(to);
  await expect(page.getByTestId('preview-rate')).toHaveText('2 sat/vB');
  await expect(page.getByTestId('preview-max-fee')).toHaveText('500 sat');
  await expect(page.getByTestId('preview-remaining')).toBeVisible();
  await expect(page.getByText('This sends XBT on Bitcoin BLAKE2b.', { exact: false })).toBeVisible();
  await expect(sendButton(page)).toHaveText('Send 0.00010000 XBT on Bitcoin BLAKE2b');
  await expectAccessible(page, 'send preview');
  await sendButton(page).click();
  await expect(page.getByTestId('onchain-confirm')).toContainText('At most 10,500 sat leaves the wallet');
  await expectAccessible(page, 'send confirmation');
  await page.getByTestId('onchain-confirm-button').click();
  await expect(page.getByTestId('onchain-outcome')).toHaveAttribute('data-state', 'succeeded');
  const txid = await page.getByTestId('onchain-sent-txid').getAttribute('title');
  await page.getByTestId('onchain-tx-link').click();
  await expect(page).toHaveURL(new RegExp(`/onchain/tx/${txid}$`));
  await expect(page.getByTestId('onchain-confirmations')).toHaveText('Unconfirmed');
  await page.goto(`${nodes.alice.path}/onchain?kind=send`);
  await expect(page.getByText(/^Sent\s/).filter({ visible: true })).toHaveCount(1);

  // The same send again warns about a duplicate and needs the acknowledgement.
  await previewSend(page, nodes.alice, to, '10000');
  await expect(sendButton(page)).toBeDisabled();
  await page.getByLabel('I checked: this is not a duplicate').check();
  await expect(sendButton(page)).toBeEnabled();
  expect(problems).toEqual([]);
});

test('fee refusals: the rate at preview, the node fee above the maximum at execute; nothing is sent', async ({
  page,
}) => {
  const nodes = await start(page);
  const to = await addressOf(page, nodes.bob);
  await previewSend(page, nodes.alice, to, '10000', 'Normal');
  await expect(page.getByTestId('send-error')).toHaveText('The fee rate is above your limit. Choose a lower fee rate.');
  await expect(page.getByTestId('preview')).toHaveCount(0);

  await previewSend(page, nodes.alice, to, '1000');
  await expect(page.getByTestId('preview-max-fee')).toHaveText('50 sat');
  await confirmSend(page);
  await expect(page.getByTestId('onchain-outcome')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByText(/the node's fee for this transaction was above the confirmed maximum/)).toBeVisible();
  // The node released the coin: the whole balance is confirmed again, nothing reserved.
  await page.goto(`${nodes.alice.path}/onchain`);
  await expect(page.getByTestId('onchain-reserved')).toHaveText('0 sat');
  await expect(page.getByTestId('onchain-confirmed')).toHaveText('500,000 sat');
});

test('form checks before the preview, and the server’s address reasons', async ({ page }) => {
  const nodes = await start(page);
  let previews = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/onchain/preview')) previews++;
  });
  await page.goto(`${nodes.alice.path}/onchain/send`);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByTestId('error')).toHaveText('Enter the address to send to.');
  await page.getByLabel('Address', { exact: true }).fill('bcrt1qnotanaddress');
  for (const amount of ['1.5', '0', '']) {
    await page.getByLabel('Amount (sat)', { exact: true }).fill(amount);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByTestId('error')).toHaveText('Enter a whole number of sats, more than zero.');
  }
  await page.getByLabel('Amount (sat)', { exact: true }).fill('1,234');
  await expect(page.getByTestId('amount-readback')).toHaveText('1,234 sat = 0.00001234 XBT');
  await page.getByRole('radio', { name: 'Custom' }).check();
  await page.getByLabel('Fee rate (sat/vB)', { exact: true }).fill('1.2345');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByTestId('error')).toContainText('at most three decimals');
  expect(previews).toBe(0);
  await page.getByLabel('Fee rate (sat/vB)', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByTestId('send-error')).toHaveText('This is not a valid address. Copy it again.');
  expect(previews).toBe(1);
});

test('step-up above the threshold asks for the password; cancelling never sends', async ({ page }) => {
  const nodes = await start(page, { spending: true, limits: { stepUpAbove: '5000' } });
  const to = await addressOf(page, nodes.bob);
  let executed = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/onchain/execute')) executed++;
  });
  await previewSend(page, nodes.alice, to, '10000');
  await confirmSend(page);
  await expect(page.getByText('This send needs your password because of the spending limits.')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('discard-this-password');
  await page.getByTestId('step-up').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('step-up')).toHaveCount(0);
  expect(executed).toBe(0);
  await confirmSend(page);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await page.getByLabel('Password', { exact: true }).fill(SHELL_PASSWORD);
  await page.getByTestId('step-up').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByTestId('onchain-outcome')).toHaveAttribute('data-state', 'succeeded');
  expect(executed).toBe(1);
});

test('a fee-rate override in the preview gives the fee reason in the password dialog', async ({ page }) => {
  const nodes = await start(page);
  const to = await addressOf(page, nodes.bob);
  // The test policy refuses a high rate instead of asking for a step-up, so mark the real preview as an override.
  await page.route('**/onchain/preview', async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...json, feeOverride: true, stepUpRequired: true } });
  });
  await previewSend(page, nodes.alice, to, '10000');
  await expect(page.getByText('The fee rate is above your limit. Your password is needed to send.')).toBeVisible();
  await confirmSend(page);
  await expect(page.getByText(/its fee rate is above your limit/)).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(SHELL_PASSWORD);
  await page.getByTestId('step-up').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByTestId('onchain-outcome')).toHaveAttribute('data-state', 'succeeded');
});

test('a lost execute reply is retried with the same body and key, and sends once', async ({ page }) => {
  const nodes = await start(page);
  const to = await addressOf(page, nodes.bob);
  const keys: string[] = [],
    bodies: unknown[] = [];
  await page.route('**/onchain/execute', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    bodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (keys.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await previewSend(page, nodes.alice, to, '10000');
  await confirmSend(page);
  await expect(page.getByText('The server could not be reached. Check the connection and try again.')).toBeVisible();
  await expect(page.getByText(/Sending again repeats the same request/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
  await confirmSend(page);
  await expect(page.getByTestId('onchain-outcome')).toHaveAttribute('data-state', 'succeeded');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(bodies[1]).toEqual(bodies[0]);
  const sends = (await (
    await page.request.get(`${(server as ShellServer).url}/api/v1/nodes/${nodes.alice.id}/onchain/transactions`)
  ).json()) as { items: { kind: string }[] };
  expect(sends.items.filter((t) => t.kind === 'send')).toHaveLength(1);
});

test('an unknown outcome says the coins stay reserved; checking again keeps the key', async ({ page }) => {
  const nodes = await start(page);
  const to = await addressOf(page, nodes.bob);
  const keys: string[] = [];
  await page.route('**/onchain/execute', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({
      status: 200,
      json: {
        intentId: '11111111-1111-4111-8111-111111111111',
        state: keys.length === 1 ? 'unknown' : 'succeeded',
        ...(keys.length > 1 ? { txid: 'ab'.repeat(32) } : {}),
      },
    });
  });
  await previewSend(page, nodes.alice, to, '10000');
  await confirmSend(page);
  await expect(page.getByTestId('onchain-outcome')).toHaveAttribute('data-state', 'unknown');
  await expect(page.getByText(/coins stay reserved until Lightning Pilot settles the send/)).toBeVisible();
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByTestId('onchain-outcome')).toHaveAttribute('data-state', 'succeeded');
  expect(keys).toEqual([keys[0], keys[0]]);
});

test('a link prefills the send form, leaves the history and never previews by itself', async ({ page }) => {
  const nodes = await start(page);
  const to = await addressOf(page, nodes.bob);
  let previews = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/onchain/preview')) previews++;
  });
  await page.goto(`${nodes.alice.path}/onchain/send?address=${to}&amount=1234`);
  await expect(page.getByLabel('Address', { exact: true })).toHaveValue(to);
  await expect(page.getByLabel('Amount (sat)', { exact: true })).toHaveValue('1234');
  await expect(page.getByTestId('from-link')).toBeVisible();
  await expect(page).toHaveURL(/\/onchain\/send$/);
  expect(previews).toBe(0);

  // The pay screen hands an address (with a BIP321 amount) over to this form.
  await page.goto(`${nodes.alice.path}/pay`);
  await page.getByLabel('Payment request', { exact: true }).fill(`bitcoin:${to}?amount=0.0002`);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByTestId('pay-handoff-onchain').click();
  await expect(page.getByLabel('Address', { exact: true })).toHaveValue(to);
  await expect(page.getByLabel('Amount (sat)', { exact: true })).toHaveValue('20000');
  await expect(page).toHaveURL(/\/onchain\/send$/);
  expect(previews).toBe(0);
});

test('transaction ids: malformed is not found, an unknown one says what was searched', async ({ page }) => {
  const nodes = await start(page);
  await page.goto(`${nodes.alice.path}/onchain/tx/not-a-txid`);
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  await page.goto(`${nodes.alice.path}/onchain/tx/${'cd'.repeat(32)}`);
  await expect(page.getByTestId('onchain-missing')).toContainText('no transaction with this id among its newest 2,000');
});

test('a node without a spend credential shows the wallet but no send action', async ({ page }) => {
  const nodes = await start(page, { readOnly: true });
  await page.goto(`${nodes.alice.path}/onchain`);
  await expect(page.getByTestId('onchain-confirmed')).toHaveText('500,000 sat');
  await expect(page.getByRole('link', { name: 'Send on-chain', exact: true })).toHaveCount(0);
  await page.goto(`${nodes.alice.path}/onchain/send`);
  await expect(page.getByText(/This action is unavailable with the current credential/)).toBeVisible();
  await expect(page.getByLabel('Address', { exact: true })).toHaveCount(0);
});
