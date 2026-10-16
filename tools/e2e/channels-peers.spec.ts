import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './axe.ts';
import { logIn, startShellServer, SHELL_PASSWORD, type ShellServer } from './shell-server.ts';

let server: ShellServer;
test.beforeEach(async () => {
  server = await startShellServer({ spending: true });
});
test.afterEach(async () => {
  await server.close();
});

async function channels(page: Page) {
  await logIn(page, server);
  const dashboard = page.url().replace(/\/$/, '');
  await page.goto(`${dashboard}/channels`);
  await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /\d+x1x0/, exact: true })).toBeVisible();
  return dashboard;
}
async function firstChannel(page: Page) {
  await page.getByRole('link', { name: /\d+x1x0/, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Channel details', exact: true })).toBeVisible();
}

test('U4: channel details, replay warning, policy and peer features are deep-linkable and accessible', async ({
  page,
}) => {
  await channels(page);
  await expect(page.getByTestId('channel-replay-warning').filter({ visible: true })).toBeVisible();
  await expectAccessible(page, 'channel list');
  await firstChannel(page);
  await page.reload();
  await expect(page.getByText('Funding outpoint', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /htlcs|history/i })).toHaveCount(0);
  await page.getByRole('link', { name: 'Forwarding policy', exact: true }).click();
  await expect(page).toHaveURL(/tab=policy/);
  await expect(page.getByText('Base forwarding fee', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Policy details are read-only in this release. Fee-policy editing comes in a later release.'),
  ).toBeVisible();
  await expectAccessible(page, 'channel policy');
  const dashboard = page.url().split('/channels/')[0];
  await page.goto(`${dashboard}/peers`);
  await page.getByRole('link', { name: 'View peer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Peer details', exact: true, level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Announced addresses', { exact: true })).toBeVisible();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `peer detail ${colorScheme}`);
  }
  expect(
    await page.evaluate(() => {
      const view = globalThis as unknown as {
        innerWidth: number;
        document: { documentElement: { scrollWidth: number } };
      };
      return view.document.documentElement.scrollWidth <= view.innerWidth;
    }),
  ).toBe(true);
});

test('U5: opening from a peer link only prefills; a preview and explicit confirmation open one channel', async ({
  page,
}) => {
  const dashboard = await channels(page);
  const response = await page.request.get(`${dashboard.replace('/n/', '/api/v1/nodes/')}/peers`);
  const { items } = await response.json();
  const peer = items[0].pubkey as string;
  let previews = 0,
    executions = 0;
  page.on('request', (request) => {
    if (request.url().includes('/channels/open/preview')) previews++;
    if (request.url().includes('/channels/open/execute')) executions++;
  });
  await page.goto(`${dashboard}/channels/open?peer=${peer}`);
  await expect(page.getByLabel('Peer public key', { exact: true })).toHaveValue(peer);
  expect(previews).toBe(0);
  expect(executions).toBe(0);
  await page.getByLabel('Funding amount (sat)', { exact: true }).fill('10000');
  await page.getByRole('button', { name: 'Preview channel action', exact: true }).click();
  await expect(page.getByTestId('preview')).toBeVisible();
  await expect(page.getByText('Maximum permitted funding fee', { exact: true })).toBeVisible();
  await expectAccessible(page, 'open preview');
  expect(executions).toBe(0);
  await page.getByRole('button', { name: /^Open channel · budget/ }).click();
  await expect(page.getByTestId('channel-outcome')).toHaveAttribute('data-state', 'succeeded');
  expect(previews).toBe(1);
  expect(executions).toBe(1);
});

test('U5: cooperative close resolves a funding-outpoint link to the canonical id and shows closed details', async ({
  page,
}) => {
  const dashboard = await channels(page);
  const response = await page.request.get(`${dashboard.replace('/n/', '/api/v1/nodes/')}/channels`);
  const { items } = await response.json();
  const row = items[0] as { id: string; fundingOutpoint: string };
  let requested = '';
  page.on('request', (request) => {
    if (request.url().includes('/channels/close/preview'))
      requested = (request.postDataJSON() as { channel: string }).channel;
  });
  await page.goto(`${dashboard}/channels/${encodeURIComponent(row.fundingOutpoint)}/close`);
  await expect(page.getByRole('button', { name: 'Preview channel action', exact: true })).toBeVisible();
  expect(requested).toBe('');
  await page.getByRole('button', { name: 'Preview channel action', exact: true }).click();
  await expect(page.getByTestId('preview')).toBeVisible();
  expect(requested).toBe(row.id);
  await expect(page.getByText(/zero budget impact does not mean closing is free/).first()).toBeVisible();
  await page.getByRole('button', { name: /^Close channel · budget/ }).click();
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page.getByTestId('channel-outcome')).toHaveAttribute('data-state', 'succeeded');
  await page.goto(`${dashboard}/channels/${encodeURIComponent(row.fundingOutpoint)}`);
  await expect(page.getByText('Close reason', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Close channel', exact: true })).toHaveCount(0);
});

test('U5: force close needs destructive confirmation and a fresh password', async ({ page }) => {
  await channels(page);
  await firstChannel(page);
  const detail = page.url().split('?')[0];
  let calls = 0;
  page.on('request', (request) => {
    if (request.url().includes('/channels/close/execute')) calls++;
  });
  await page.goto(`${detail}/close?force=1`);
  await page.getByRole('button', { name: 'Preview channel action', exact: true }).click();
  await page.getByRole('button', { name: /^Force close · budget/ }).click();
  await expect(page.getByTestId('destructive-confirm')).toBeVisible();
  expect(calls).toBe(0);
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page.getByTestId('step-up')).toBeVisible();
  expect(calls).toBe(0);
  await page.getByLabel('Password', { exact: true }).fill(SHELL_PASSWORD);
  await page.getByTestId('step-up').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByTestId('channel-outcome')).toHaveAttribute('data-state', 'succeeded');
  expect(calls).toBe(1);
});

test('U5: peer connection and explicit disconnection use real routes', async ({ page }) => {
  const dashboard = await channels(page);
  const pubkey = '03' + '22'.repeat(32);
  await page.goto(`${dashboard}/peers/connect?peer=${pubkey}`);
  await page.getByRole('button', { name: 'Connect peer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Peer details', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect peer', exact: true }).click();
  await expect(page.getByTestId('destructive-confirm')).toBeVisible();
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
});

test('a lost execute reply retries the same token and idempotency key without another channel', async ({ page }) => {
  const dashboard = await channels(page);
  const { items } = await (await page.request.get(`${dashboard.replace('/n/', '/api/v1/nodes/')}/peers`)).json();
  const keys: string[] = [],
    bodies: unknown[] = [];
  await page.route('**/channels/open/execute', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    bodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (keys.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await page.goto(`${dashboard}/channels/open?peer=${items[0].pubkey}`);
  await page.getByLabel('Funding amount (sat)', { exact: true }).fill('10000');
  await page.getByRole('button', { name: 'Preview channel action', exact: true }).click();
  await page.getByRole('button', { name: /^Open channel · budget/ }).click();
  await expect(page.getByText('The server could not be reached. Check the connection and try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit and preview again', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /^Open channel · budget/ }).click();
  await expect(page.getByTestId('channel-outcome')).toHaveAttribute('data-state', 'succeeded');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(bodies[1]).toEqual(bodies[0]);
  const result = await (await page.request.get(`${dashboard.replace('/n/', '/api/v1/nodes/')}/channels`)).json();
  expect(result.items).toHaveLength(2);
});

test('unknown and pending-close outcomes are distinct and result checks keep the same key', async ({ page }) => {
  await channels(page);
  await firstChannel(page);
  const detail = page.url().split('?')[0];
  const keys: string[] = [];
  await page.route('**/channels/close/execute', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({
      status: 200,
      json: {
        intentId: '11111111-1111-4111-8111-111111111111',
        state: keys.length === 1 ? 'unknown' : 'succeeded',
        ...(keys.length > 1 ? { closeType: 'pending' } : {}),
      },
    });
  });
  await page.goto(`${detail}/close`);
  await page.getByRole('button', { name: 'Preview channel action', exact: true }).click();
  await page.getByRole('button', { name: /^Close channel · budget/ }).click();
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page.getByTestId('channel-outcome')).toHaveAttribute('data-state', 'unknown');
  await page.getByRole('button', { name: 'Check the same request', exact: true }).click();
  await expect(page.getByText('Close pending: waiting for the peer', { exact: true })).toBeVisible();
  expect(keys[1]).toBe(keys[0]);
});

test('read-only nodes keep browsing but cannot start channel or peer writes', async ({ page }) => {
  await server.close();
  server = await startShellServer({ readOnly: true });
  const dashboard = await channels(page);
  await expect(page.getByRole('link', { name: 'Open channel', exact: true })).toHaveCount(0);
  await page.goto(`${dashboard}/channels/open`);
  await expect(page.getByText(/This action is unavailable with the current credential/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview channel action', exact: true })).toHaveCount(0);
  await page.goto(`${dashboard}/peers/connect`);
  await expect(page.getByText(/This action is unavailable with the current credential/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect peer', exact: true })).toHaveCount(0);
});

test('loaded-page filtering and sorting survive reload; scope errors offer retry and recover', async ({ page }) => {
  const dashboard = await channels(page);
  let denied = false;
  await page.route('**/api/v1/nodes/*/channels?*', async (route) => {
    if (denied) {
      await route.fulfill({
        status: 403,
        json: { error: { code: 'capability_missing', message: 'missing scope', requestId: 'r-channel-scope' } },
      });
      return;
    }
    const source = new URL(route.request().url());
    source.searchParams.delete('cursor');
    const response = await route.fetch({ url: source.toString() });
    const body = await response.json();
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    await route.fulfill({
      response,
      json: {
        items: body.items.map((item: { id: string }) => ({
          ...item,
          ...(cursor ? { id: 'ab'.repeat(32), shortChannelId: '901x1x0' } : {}),
        })),
        ...(!cursor ? { nextCursor: 'page-two' } : {}),
      },
    });
  });
  await page.reload();
  await expect(page.getByText(/Only loaded channels are filtered/)).toBeVisible();
  await page.getByRole('button', { name: 'Load more channels', exact: true }).click();
  await expect(page.getByRole('link', { name: '901x1x0', exact: true })).toBeVisible();
  await page.getByLabel('Sort loaded channels', { exact: true }).selectOption('local');
  await page.getByLabel('Filter loaded channels', { exact: true }).fill('901x1x0');
  await page.reload();
  await expect(page.getByLabel('Filter loaded channels', { exact: true })).toHaveValue('901x1x0');
  await expect(page.getByLabel('Sort loaded channels', { exact: true })).toHaveValue('local');
  await expect(page.getByRole('link', { name: '900x1x0', exact: true })).toHaveCount(0);
  await page.getByLabel('Filter loaded channels', { exact: true }).fill('missing');
  await expect(page.getByText('No channels to show', { exact: true }).filter({ visible: true })).toBeVisible();
  denied = true;
  await page.goto(`${dashboard}/channels`);
  await page.reload();
  await expect(page.getByText('Request id: r-channel-scope', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  denied = false;
  await page.reload();
  await expect(page.getByRole('link', { name: '900x1x0', exact: true })).toBeVisible();
});

test('duplicate acknowledgement is explicit and a node switch discards the preview', async ({ page }) => {
  const dashboard = await channels(page);
  const { items } = await (await page.request.get(`${dashboard.replace('/n/', '/api/v1/nodes/')}/peers`)).json();
  let executed = 0;
  page.on('request', (r) => {
    if (r.url().includes('/channels/open/execute')) executed++;
  });
  await page.route('**/channels/open/preview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, duplicateWarning: true } });
  });
  await page.goto(`${dashboard}/channels/open?peer=${items[0].pubkey}`);
  await page.getByLabel('Funding amount (sat)', { exact: true }).fill('10000');
  await page.getByRole('button', { name: 'Preview channel action', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Open channel · budget/ })).toBeDisabled();
  await page.getByLabel('I checked the similar spend and intend this additional operation.', { exact: true }).check();
  await expect(page.getByRole('button', { name: /^Open channel · budget/ })).toBeEnabled();
  // A deep link to a different node must not carry the first node's confirmation state.
  const nodes = await (await page.request.get(`${server.url}/api/v1/nodes`)).json();
  const other = nodes.items.find((n: { id: string }) => !dashboard.endsWith(n.id));
  await page.goto(`${server.url}/n/${other.id}/channels/open`);
  await expect(page.getByLabel('Peer public key', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('preview')).toHaveCount(0);
  expect(executed).toBe(0);
});

test('cancelling a force-close password step never executes and clears the password', async ({ page }) => {
  await channels(page);
  await firstChannel(page);
  await page.goto(`${page.url().split('?')[0]}/close?force=1`);
  let executed = 0;
  page.on('request', (r) => {
    if (r.url().includes('/channels/close/execute')) executed++;
  });
  await page.getByRole('button', { name: 'Preview channel action', exact: true }).click();
  await page.getByRole('button', { name: /^Force close · budget/ }).click();
  await page.getByTestId('destructive-confirm-button').click();
  await page.getByLabel('Password', { exact: true }).fill('discard-this-password');
  await page.getByTestId('step-up').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('step-up')).toHaveCount(0);
  await page.getByRole('button', { name: /^Force close · budget/ }).click();
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  expect(executed).toBe(0);
});

test('cooperative external close previews the exact destination and needs confirmation', async ({ page }) => {
  const dashboard = await channels(page);
  const base = dashboard.replace('/n/', '/api/v1/nodes/');
  const funds = await (await page.request.get(`${base}/onchain/utxos`)).json();
  const address = funds.items[0].address as string;
  await firstChannel(page);
  await page.goto(`${page.url().split('?')[0]}/close`);
  await page.getByLabel('Closing destination', { exact: true }).fill(address);
  await page.getByRole('button', { name: 'Preview channel action', exact: true }).click();
  await expect(page.getByTestId('preview').getByText(address, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Close channel · budget/ }).click();
  await page.getByTestId('destructive-confirm-button').click();
  await expect(page.getByTestId('channel-outcome')).toHaveAttribute('data-state', 'succeeded');
});

test('peer high feature bits and untrusted aliases render as text', async ({ page }) => {
  const dashboard = await channels(page);
  await page.route('**/api/v1/nodes/*/peers', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        items: body.items.map((p: object) => ({
          ...p,
          alias: '<img src=x onerror=alert(1)>',
          features: '0f' + '00'.repeat(64),
        })),
      },
    });
  });
  await page.goto(`${dashboard}/peers`);
  await page.getByRole('link', { name: 'View peer', exact: true }).click();
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  for (const label of [
    'BLAKE2b (required)',
    'BLAKE2b (optional)',
    'Unified signatures (required)',
    'Unified signatures (optional)',
  ])
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.locator('main img, main script')).toHaveCount(0);
});
