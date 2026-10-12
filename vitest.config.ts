import { defineConfig } from 'vitest/config';

// One test run for the whole repository. Packages that need a browser-like environment configure it in their
// own test files (`// @vitest-environment jsdom` or similar) when the UI work packages add them.
export default defineConfig({
  test: {
    include: ['packages/**/*.test.{ts,tsx}', 'apps/**/*.test.{ts,tsx}', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
  },
});
