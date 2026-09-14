import js from '@eslint/js';

/**
 * Node globals the plugin and its tests touch. Listed by hand so that
 * devDependencies stay at two packages.
 */
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Response: 'readonly',
  fetch: 'readonly',
  structuredClone: 'readonly',
};

export default [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // The browser half is a client bundle, not an ES module: it registers its
    // factory through the page global and receives externals as `require`.
    files: ['lib/client.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { window: 'readonly', require: 'readonly' },
    },
  },
  {
    ignores: ['node_modules/', 'public/'],
  },
];
