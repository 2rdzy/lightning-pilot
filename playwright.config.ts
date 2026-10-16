// Browser end-to-end tests (tools/e2e, *.spec.ts so Vitest does not pick them up). Global setup builds nothing: run
// `pnpm build:web` first. It starts one development server per project (tools/dev/server.ts) on a fresh database,
// so the desktop and the phone run each walk the whole flow from setup. Nodes: fake by default; with
// E2E_NODES=regtest, the tools/regtest nodes of LP_REGTEST_CHAIN. baseURL must be http://localhost: the server allows
// plain-HTTP origins on localhost only.
import { defineConfig, devices } from '@playwright/test';

export const E2E_PORTS = { desktop: 8091, phone: 8092 } as const;

export default defineConfig({
  testDir: 'tools/e2e',
  testMatch: '*.spec.ts',
  // Visual baselines (visual.spec.ts) are made in one pinned image only, so no platform suffix.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  globalSetup: './tools/e2e/global-setup.ts',
  // Regtest payments share the nodes' channels: one test at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Fixed region and time zone: the test checks formatted amounts ("1,000 sat").
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'en-US', timezoneId: 'UTC' },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        baseURL: `http://localhost:${E2E_PORTS.desktop}`,
      },
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], baseURL: `http://localhost:${E2E_PORTS.phone}` },
    },
  ],
});
