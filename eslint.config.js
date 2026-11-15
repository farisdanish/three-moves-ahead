import { defineConfig } from 'eslint/config';
import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default defineConfig([
  tseslint.configs.recommended,
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/server/**/*.{ts,tsx,mjs,cjs,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      parserOptions: {
        project: ['./tools/tsconfig.server.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/shared/**/*.{ts,tsx,mjs,cjs,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals['shared-node-browser'],
      parserOptions: {
        project: ['./tools/tsconfig.shared.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/client/**/*.{ts,tsx}'],
    ignores: ['src/server/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: {
        project: ['./tools/tsconfig.client.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'alert',
          message:
            'Use showToast or showForm from @devvit/web/client instead of alert.',
        },
        {
          name: 'location',
          message:
            'Use navigateTo from @devvit/web/client instead of window.location.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'alert',
          message:
            'Use showToast or showForm from @devvit/web/client instead of window.alert.',
        },
        {
          object: 'window',
          property: 'location',
          message:
            'Use navigateTo from @devvit/web/client instead of window.location.',
        },
        {
          object: 'globalThis',
          property: 'alert',
          message:
            'Use showToast or showForm from @devvit/web/client instead of window.alert.',
        },
        {
          object: 'globalThis',
          property: 'location',
          message:
            'Use navigateTo from @devvit/web/client instead of window.location.',
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-unused-vars': ['off'],
      'no-unused-vars': ['off'],
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@devvit/public-api',
              message: 'Use @devvit/web instead of legacy @devvit/public-api.',
            },
          ],
          patterns: [
            {
              group: ['@devvit/public-api/*'],
              message: 'Use @devvit/web instead of legacy @devvit/public-api.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program > ExportDefaultDeclaration',
          message: 'Prefer named exports over default exports.',
        },
      ],
    },
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'eslint.config.js',
      '**/vite.config.ts',
      'devvit.config.ts',
    ],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { js },
    extends: ['js/recommended'],
  },
]);
