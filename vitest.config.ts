import { defineConfig } from 'vitest/config';

// One test run for the whole repository. Packages that need a browser-like environment configure it in their
// own test files (`// @vitest-environment jsdom` or similar) when the UI work packages add them. Tests that need
// the regtest nodes (`*.regtest.test.ts`) run separately: vitest.regtest.config.ts.
//
// Coverage gates (repository conventions §7): 95 % of lines and branches for money and the security modules
// (vault, auth with its sessions, spend), 80 % everywhere else. The entry point (main.ts) is left out: it only wires
// the parts together and is checked by starting it.
const GATED = { lines: 95, branches: 95 };

export default defineConfig({
  test: {
    include: ['packages/**/*.test.{ts,tsx}', 'apps/**/*.test.{ts,tsx}', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.regtest.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/index.ts',
        '**/fixtures/**',
        'apps/server/src/main.ts',
        'apps/server/src/testing.ts',
      ],
      reporter: ['text-summary', 'text'],
      thresholds: {
        lines: 80,
        branches: 80,
        'packages/core/src/money.ts': GATED,
        'apps/server/src/modules/vault/**': GATED,
        'apps/server/src/modules/auth/**': GATED,
        'apps/server/src/modules/spend/**': GATED,
      },
    },
  },
});
