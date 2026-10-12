import { defineConfig } from 'vitest/config';

// Tests against the tools/regtest nodes of one chain: LP_REGTEST_CHAIN=blake2b|sha256d pnpm test:regtest.
// Run one file at a time: the tests share the nodes and their channel balances.
export default defineConfig({
  test: {
    include: ['packages/**/*.regtest.test.ts', 'apps/**/*.regtest.test.ts', 'tools/**/*.regtest.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
