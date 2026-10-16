// The app shell in the browser (WP15): the desktop and phone layouts, the Basic/Advanced toggle and the theme kept
// per device, the live connection, the logo and favicons, and an axe check of each screen in both themes. Against
// the built web app on the real server (its CSP included), with fake nodes. Run `pnpm build:web` first.
import { expect, test } from '@playwright/test';
import { expectAccessible } from './axe.ts';
import { logIn, startShellServer, watchConsole, type ShellServer } from './shell-server.ts';

let server: ShellServer;
test.beforeEach(async () => {
  server = await startShellServer();
});
test.afterEach(async () => {
  await server.close();
});

test('login and setup frame are accessible in both themes', async ({ page }) => {
  const problems = watchConsole(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${server.url}/login`);
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
    await expect(page.getByTestId('logo')).toBeVisible();
    await expectAccessible(page, `login, ${scheme}`);
  }
  // A failed login names neither factor (implementation notes §18 item 12).
  await page.getByLabel('Password', { exact: true }).fill('Wrong-password-1!');
  await page.getByLabel('Authenticator code').fill('000000');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByText('The password or the code is not correct.')).toBeVisible();
  await expectAccessible(page, 'login failed');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the shell: layout, live connection, view, theme and screens, accessible in both themes', async ({
  page,
}, testInfo) => {
  const problems = watchConsole(page);
  const phone = testInfo.project.name === 'phone';
  await logIn(page, server);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // The chain is always on screen, with the live connection established.
  await expect(page.getByTestId('chain-badge')).toHaveText('BLAKE2b ✓');
  await expect(page.getByTestId('node-select')).toBeVisible();
  if (phone) {
    // Phone: top bar in --bar, tab bar Home · Pay · Receive · More (Channels appears once WP17 builds it).
    const bar = page.locator('header');
    await expect(bar).toHaveCSS('background-color', 'rgb(130, 42, 28)');
    await expect(nav.getByRole('link')).toHaveText(['Home', 'Channels', 'Pay', 'Receive']);
    await expect(nav.getByRole('button', { name: 'More' })).toBeVisible();
    await nav.getByRole('button', { name: 'More' }).click();
    const panel = page.getByTestId('menu-panel');
    await expect(panel.getByTestId('live-indicator')).toHaveAttribute('data-state', 'live');
    await expect(panel.getByTestId('block-height')).toHaveText(/^Height [0-9,]+$/);
    await expect(panel.getByRole('link', { name: 'Settings' })).toBeVisible();
    // Basic by default on a phone.
    await expect(panel.getByRole('button', { name: 'Basic' })).toHaveAttribute('aria-pressed', 'true');
    await expectAccessible(page, 'phone, More open');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    // Focus returns to the More button.
    await expect(nav.getByRole('button', { name: 'More' })).toBeFocused();
  } else {
    await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-state', 'live');
    await expect(page.getByTestId('block-height')).toHaveText(/^Height [0-9,]+$/);
    await expect(nav.getByRole('link')).toHaveText([
      'Dashboard',
      'Channels',
      'Peers',
      'Node',
      'Pay',
      'Receive',
      'Settings',
    ]);
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    // Advanced by default on a desktop; the choice is kept for this device.
    const toggle = page.getByTestId('view-toggle');
    await expect(toggle.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-pressed', 'true');
    await toggle.getByRole('button', { name: 'Basic' }).click();
    await page.reload();
    await expect(page.getByTestId('view-toggle').getByRole('button', { name: 'Basic' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByTestId('view-toggle').getByRole('button', { name: 'Advanced' }).click();
    // The navigation collapses to icons and keeps its names.
    await nav.getByRole('button', { name: 'Collapse the navigation' }).click();
    await expect(nav.getByRole('link', { name: 'Pay' })).toHaveText('');
    await nav.getByRole('button', { name: 'Expand the navigation' }).click();
    await expect(nav.getByRole('link', { name: 'Pay' })).toHaveText('Pay');
  }

  // The theme follows the system until one is chosen, then stays chosen after a reload.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(19, 20, 22)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(240, 244, 247)');
  if (phone) await nav.getByRole('button', { name: 'More' }).click();
  await page.getByTestId('theme-switch').getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(19, 20, 22)');

  // Every screen of the shell passes axe in both themes.
  const node = new URL(page.url()).pathname;
  for (const theme of ['dark', 'light'] as const) {
    if (phone) await nav.getByRole('button', { name: 'More' }).click();
    await page
      .getByTestId('theme-switch')
      .getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light' })
      .click();
    if (phone) await page.keyboard.press('Escape');
    for (const [path, heading] of [
      ['', 'Dashboard'],
      ['/receive', 'Receive'],
      ['/pay', 'Pay'],
    ] as const) {
      await page.goto(`${server.url}${node}${path}`);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expectAccessible(page, `${path || '/'} in ${theme}`);
    }
  }

  // Unknown pages show "not found" with a way back.
  await page.goto(`${server.url}/n/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  await expectAccessible(page, 'not found');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('logo, favicons and manifest are served from the app itself', async ({ page }) => {
  await page.goto(`${server.url}/login`);
  const icons = await page.locator('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').all();
  expect(icons).toHaveLength(4);
  for (const [path, type] of [
    ['/favicon.svg', 'image/svg+xml'],
    ['/favicon.ico', 'image/'],
    ['/apple-touch-icon.png', 'image/png'],
    ['/icons/icon-192.png', 'image/png'],
    ['/icons/icon-512.png', 'image/png'],
    ['/icons/icon-maskable-512.png', 'image/png'],
    ['/manifest.webmanifest', 'application/manifest+json'],
  ] as const) {
    const response = await page.request.get(`${server.url}${path}`);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type'], path).toContain(type);
  }
  const manifest = (await (await page.request.get(`${server.url}/manifest.webmanifest`)).json()) as {
    icons: { purpose: string }[];
  };
  expect(manifest.icons.map((i) => i.purpose)).toEqual(['any', 'any', 'maskable']);
});
