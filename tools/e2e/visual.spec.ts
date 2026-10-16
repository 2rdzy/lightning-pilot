// Visual snapshots of the shell (WP15 acceptance; ci §2, review R18): desktop in the Advanced view and phone in the
// Basic view, each in light and dark. Only inside the pinned Playwright image (tools/e2e/visual.sh): the system
// font stack renders differently on every machine, so baselines made anywhere else would not match CI. Values that
// change between runs (block height, pubkey, live state) are masked.
import { expect, test } from '@playwright/test';
import { logIn, startShellServer, type ShellServer } from './shell-server.ts';

test.skip(!process.env.E2E_VISUAL, 'visual snapshots run only in the Playwright image: pnpm test:visual');

let server: ShellServer;
test.beforeEach(async () => {
  server = await startShellServer();
});
test.afterEach(async () => {
  await server.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`dashboard in the default view, ${scheme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await logIn(page, server);
    const view = testInfo.project.name === 'phone' ? 'basic' : 'advanced';
    if (view === 'advanced') {
      await expect(page.getByTestId('view-toggle').getByRole('button', { name: 'Advanced' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-state', 'live');
    }
    await expect(page.getByText(/^[0-9]+ active channels?$/)).toBeVisible();
    await expect(page).toHaveScreenshot(`dashboard-${view}-${scheme}.png`, {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByTestId('block-height'), page.getByTestId('live-indicator'), page.locator('dd.font-mono')],
    });
  });
}
