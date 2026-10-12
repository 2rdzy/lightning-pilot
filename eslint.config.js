// Lint rules: strict TypeScript, a few security rules, and the module boundaries of the architecture (§4):
// core depends on nothing of ours; chain and the adapters only on core; the web app only on core and ui;
// the server on everything except ui. A boundary mistake fails CI.
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const elements = [
  { type: 'core', pattern: 'packages/core' },
  { type: 'chain', pattern: 'packages/chain' },
  { type: 'adapter', pattern: 'packages/adapter-(cln|lnd)' },
  { type: 'adapter-kit', pattern: 'packages/adapter-kit' },
  { type: 'ui', pattern: 'packages/ui' },
  { type: 'server', pattern: 'apps/server' },
  { type: 'web', pattern: 'apps/web' },
  { type: 'tools', pattern: 'tools' },
];

// Which of our packages each directory may import by name (mirrors the policies below).
const allowedPackages = {
  'packages/core': [],
  'packages/chain': ['core'],
  'packages/adapter-cln': ['core'],
  'packages/adapter-lnd': ['core'],
  'packages/adapter-kit': ['core'],
  'packages/ui': ['core'],
  'apps/web': ['core', 'ui'],
  'apps/server': ['core', 'chain', 'adapter-cln', 'adapter-lnd', 'adapter-kit'],
};

const allow = (from, to) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: to } } } },
});

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'tools/lint-fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Untrusted text is never rendered as HTML (architecture §5).',
        },
      ],
    },
  },
  {
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}', 'tools/**/*.{ts,mjs,js}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': elements,
      'boundaries/include': ['packages/**/*', 'apps/**/*', 'tools/**/*'],
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.mjs'] } },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            allow('core', ['core']),
            allow('chain', ['chain', 'core']),
            allow('adapter', ['adapter', 'core']),
            allow('adapter-kit', ['adapter-kit', 'core']),
            allow('ui', ['ui', 'core']),
            allow('web', ['web', 'core', 'ui']),
            allow('server', ['server', 'core', 'chain', 'adapter', 'adapter-kit']),
            allow('tools', ['tools', 'core', 'chain', 'adapter', 'adapter-kit', 'ui', 'server', 'web']),
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ui/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // Second guard for imports by package name: the boundaries plugin does not see through the workspace links in
  // node_modules, so each package also lists which of our packages it may import.
  ...Object.entries(allowedPackages).map(([dir, allowed]) => ({
    files: [`${dir}/**/*.{ts,tsx,js,mjs}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `^@lightning-pilot/(?!(${allowed.join('|') || '$^'})(/|$))`,
              message: 'This package may not import that Lightning Pilot package (architecture §4).',
            },
          ],
        },
      ],
    },
  })),
);
