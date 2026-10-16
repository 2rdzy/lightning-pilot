// Component tests in a real browser (Vitest browser mode, Chromium through Playwright; agreed 2026-10-13 instead of
// jsdom, which has no CSS or layout). Run with `pnpm test:browser` after `pnpm exec playwright install chromium`.
// Kept out of `pnpm test` and `pnpm check`, whose CI job has no browser; CI runs them in the e2e job.
// Coverage: the components' logic lives in plain .ts modules, measured by the Node run; these tests check rendering,
// focus, keyboard use, themes and accessibility (axe-core).
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Pre-bundled up front: discovered during the run, Vite reloads the page and the test file fails to import.
  optimizeDeps: {
    include: [
      '@base-ui/react/alert-dialog',
      '@base-ui/react/csp-provider',
      '@base-ui/react/dialog',
      '@base-ui/react/popover',
      '@base-ui/react/toast',
      '@base-ui/react/toggle',
      '@base-ui/react/toggle-group',
      'axe-core',
      'lucide-react',
      'qrcode-generator',
      'react',
      'react/jsx-dev-runtime',
      'vitest-browser-react',
    ],
  },
  test: {
    include: ['packages/*/src/**/*.browser.test.tsx', 'apps/*/src/**/*.browser.test.tsx'],
    setupFiles: ['tools/browser/setup.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      viewport: { width: 1280, height: 800 },
    },
  },
});
