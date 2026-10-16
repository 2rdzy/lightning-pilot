import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe.ts';
import { logIn, startShellServer, type ShellServer } from './shell-server.ts';

let server: ShellServer;
test.beforeEach(async () => {
  server = await startShellServer();
});
test.afterEach(async () => {
  await server.close();
});

test('U3: balances, liquidity and node details are deep-linkable and accessible', async ({ page }) => {
  await logIn(page, server);
  await expect(page.getByTestId('balance-pending-close')).toBeVisible();
  await expect(page.getByTestId('balance-reserved')).toBeVisible();
  await expect(page.getByRole('img', { name: /^Local .*remote/ })).toBeVisible();
  await expect(page.getByTestId('node-identity')).toHaveAttribute('data-state', 'confirmed');
  await expectAccessible(page, 'WP16 dashboard');
  await page.getByRole('link', { name: 'View node details' }).click();
  await expect(page.getByRole('heading', { name: 'Node info', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('node-pubkey')).toBeVisible();
  await expect(page.getByText('Spend credential (last verification)', { exact: true })).toBeVisible();
  await expect(page.getByText(/Spend status comes from the last credential verification/)).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectAccessible(page, `WP16 node, ${scheme}`);
  }
  expect(
    await page.evaluate(() => {
      const browser = globalThis as unknown as {
        document: { documentElement: { scrollWidth: number } };
        innerWidth: number;
      };
      return browser.document.documentElement.scrollWidth <= browser.innerWidth;
    }),
  ).toBe(true);
});

test('U2: waiting and refused identity explain why spending is blocked', async ({ page }) => {
  let state: 'waiting' | 'refused' = 'waiting';
  await page.route('**/api/v1/nodes/*/info', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        chainIdentity: {
          ...body.chainIdentity,
          state,
          failedCheck: 'header',
          detail: '<script>untrusted detail</script>',
        },
      },
    });
  });
  await logIn(page, server);
  await page.getByRole('link', { name: 'View node details' }).click();
  await expect(page.getByTestId('node-identity')).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByText('The chain check has not finished. Spending is blocked until it passes.')).toBeVisible();
  state = 'refused';
  await page.reload();
  await expect(page.getByTestId('node-identity')).toHaveAttribute('data-state', 'refused');
  await expect(page.getByText('The chain check failed. Spending is blocked until it passes.')).toBeVisible();
  await expect(page.getByText('<script>untrusted detail</script>', { exact: true })).toBeVisible();
  await expect(page.locator('main script')).toHaveCount(0);
});

test('node URIs preserve IPv6 and case; clipboard refusal leaves selectable text', async ({ page }) => {
  await page.route('**/api/v1/nodes/*/info', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        addresses: ['[::1]:9735', 'Example.onion:9735'],
        alias: '<img src=x onerror=alert(1)>extra-long-untrusted-alias',
      },
    });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
  });
  await logIn(page, server);
  await page.getByRole('link', { name: 'View node details' }).click();
  const key = await page.getByTestId('node-pubkey').textContent();
  await expect(page.getByTestId('node-uri')).toHaveText([`${key}@[::1]:9735`, `${key}@Example.onion:9735`]);
  await expect(page.getByRole('img', { name: 'Lightning node connection URI' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Copy', exact: true }).last().click();
  await expect(page.getByRole('textbox', { name: /Copying did not work/ })).toHaveValue(`${key}@Example.onion:9735`);
  await expect(page.locator('main img')).toHaveCount(0);
});

test('empty announcements and capabilities, and each credential state, are explicit', async ({ page }) => {
  await page.route('**/api/v1/nodes/*/info', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, addresses: [], capabilities: [] } });
  });
  let spend = 'unknown';
  await page.route('**/api/v1/nodes/*/credentials', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, credentials: { view: 'revoked', spend }, checkedAt: null } });
  });
  await logIn(page, server);
  await page.getByRole('link', { name: 'View node details' }).click();
  await expect(page.getByText('No announced addresses', { exact: true })).toBeVisible();
  await expect(page.getByText('No capabilities reported.', { exact: true })).toBeVisible();
  for (const state of ['unknown', 'missing', 'revoked', 'ok']) {
    spend = state;
    await page.reload();
    const panel = page.getByRole('heading', { name: 'Credential status', exact: true }).locator('../..');
    await expect(
      panel.getByText(state === 'ok' ? 'OK' : state[0]?.toUpperCase() + state.slice(1), { exact: true }).last(),
    ).toBeVisible();
    await expect(panel.getByText('Not yet verified', { exact: true })).toBeVisible();
  }
});

test('scope errors have retry and do not hide other panels; amounts never round up', async ({ page }) => {
  await page.route('**/api/v1/nodes/*/balances', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, lightning: { ...body.lightning, spendable: '1000500' } } });
  });
  await logIn(page, server);
  await expect(page.getByTestId('balance-spendable')).toHaveText('1,000 sat');
  await expect(page.getByTestId('balance-spendable')).toHaveAttribute('title', 'Exactly 1,000.500 sat');
  let fail = true;
  await page.route('**/api/v1/nodes/*/info', async (route) => {
    if (fail)
      await route.fulfill({
        status: 409,
        json: { error: { code: 'capability_missing', message: 'scope', requestId: 'r-scope' } },
      });
    else await route.continue();
  });
  await page.getByRole('link', { name: 'View node details' }).click();
  await expect(page.getByText(/This credential cannot show this information/)).toBeVisible();
  await expect(page.getByText('View credential', { exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('node-pubkey')).toBeVisible();
});

test('switching nodes cannot display a late answer from the previous node', async ({ page }) => {
  await logIn(page, server);
  await page.getByRole('link', { name: 'View node details' }).click();
  const original = page.url();
  const carol = await page.getByTestId('node-select').locator('option', { hasText: 'carol' }).getAttribute('value');
  if (!carol) throw new Error('Missing SHA256d fixture node');
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/v1/nodes/*/info', async (route) => {
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await pending;
  await page.getByTestId('node-select').selectOption(carol);
  release();
  await expect(page).not.toHaveURL(original);
  await expect(page.getByTestId('chain-badge')).toHaveText('SHA256d ✓');
  await page.getByRole('link', { name: 'View node details' }).click();
  await expect(page.getByTestId('node-pubkey')).toBeVisible();
  await expect(page.locator('main').getByText('carol', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('alice', { exact: true })).toHaveCount(0);
});

test('live events and reconnect refresh balances; a failed refresh labels cached values', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as unknown as {
      EventSource: typeof EventSource;
      wp16Stream: EventSource;
      wp16Streams: number;
    };
    const Native = state.EventSource;
    state.wp16Streams = 0;
    state.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        state.wp16Stream = this;
        state.wp16Streams++;
      }
    };
  });
  let amount = '1000000';
  let fail = false;
  await page.route('**/api/v1/nodes/*/balances', async (route) => {
    if (fail)
      return route.fulfill({
        status: 502,
        json: { error: { code: 'node_unreachable', message: 'node unreachable', requestId: 'r-live' } },
      });
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, lightning: { ...body.lightning, spendable: amount } } });
  });
  await logIn(page, server);
  const signal = (type: string) =>
    page.evaluate((name) => {
      (globalThis as unknown as { wp16Stream: EventSource }).wp16Stream.dispatchEvent(
        new MessageEvent(name, { data: '{}' }),
      );
    }, type);
  await expect(page.getByTestId('balance-spendable')).toHaveText('1,000 sat');
  amount = '2000000';
  await signal('balances.updated');
  await expect(page.getByTestId('balance-spendable')).toHaveText('2,000 sat');
  amount = '3000000';
  await signal('open');
  await expect(page.getByTestId('balance-spendable')).toHaveText('3,000 sat');
  fail = true;
  await signal('balances.updated');
  await expect(page.getByText('Refresh failed. Previously loaded data is shown; it may be out of date.')).toBeVisible();
  await expect(page.getByTestId('balance-spendable')).toHaveText('3,000 sat');
  fail = false;
  amount = '4000000';
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('balance-spendable')).toHaveText('4,000 sat');
  expect(await page.evaluate(() => (globalThis as unknown as { wp16Streams: number }).wp16Streams)).toBe(1);
});
