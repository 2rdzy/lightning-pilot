import { defineConfig } from 'vitest/config';

// One test run for the whole repository, in Node. Component tests that need a real browser
// (`*.browser.test.tsx`) run separately: vitest.browser.config.ts. Tests that need the regtest nodes
// (`*.regtest.test.ts`) run separately too: vitest.regtest.config.ts.
//
// Coverage gates (repository conventions §7): 95 % of lines and branches for money and the security modules
// (vault, auth with its sessions, spend), the payment request decoders (threat T18) and the chain identity check
// (chain profiles, header parsing and the identity monitor, threat T20) and the wallet module (architecture §10),
// 80 % everywhere else. The entry point (main.ts) is left out: it only wires
// the parts together and is checked by starting it. React components (*.tsx of the web app and of packages/ui) are
// left out too: they are tested in a real browser (pnpm test:browser, vitest.browser.config.ts) and by Playwright
// (pnpm test:e2e, CI job e2e); their logic lives in plain .ts modules, which count.
const GATED = { lines: 95, branches: 95 };

export default defineConfig({
  test: {
    include: ['packages/**/*.test.{ts,tsx}', 'apps/**/*.test.{ts,tsx}', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.regtest.test.ts', '**/*.browser.test.tsx'],
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
        'apps/web/src/**/*.tsx',
        'packages/ui/src/**/*.tsx',
      ],
      reporter: ['text-summary', 'text'],
      thresholds: {
        lines: 80,
        branches: 80,
        'packages/core/src/money.ts': GATED,
        'packages/core/src/decode/**': GATED,
        'packages/chain/src/**': GATED,
        'apps/server/src/modules/nodes/identity/**': GATED,
        'apps/server/src/modules/vault/**': GATED,
        'apps/server/src/modules/export/**': GATED,
        'apps/server/src/modules/auth/**': GATED,
        'apps/server/src/modules/setup/**': GATED,
        'apps/server/src/modules/sessions/**': GATED,
        'apps/server/src/modules/spend/**': GATED,
        'apps/server/src/modules/wallet/**': GATED,
      },
    },
  },
});
