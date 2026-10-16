import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  { ignores: ['coverage/**', 'node_modules/**', 'LICENSES/**', '*.tgz', '.test-tmp/**'] },
  js.configs.recommended,
  {
    files: [
      'eslint.config.js',
      'lib/**/*.js',
      // The in-package sub-package, and the postinstall that delivers it: both
      // ship, so both are linted like the rest of the source.
      'effort-memory/**/*.js',
      'scripts/**/*.mjs',
      'test/**/*.{js,mjs}',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },
]);
