// @ts-check
'use strict';

/**
 * Root ESLint configuration for the ai-hivemind monorepo.
 *
 * CRITICAL: The rules listed under IMMUTABLE_RULES below may never be disabled
 * via eslint-disable comments anywhere in the repository. Doing so will cause
 * PR review failure. See docs/WORKFLOW.md §3.3 for full rationale.
 */

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./tsconfig.json', './apps/*/tsconfig.json', './packages/*/tsconfig.json'],
    tsconfigRootDir: __dirname,
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ['@typescript-eslint', 'import', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
    'plugin:@typescript-eslint/stylistic-type-checked',
    'plugin:import/recommended',
    'plugin:import/typescript',
  ],
  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: ['./tsconfig.json', './apps/*/tsconfig.json', './packages/*/tsconfig.json'],
      },
    },
    react: {
      version: 'detect',
    },
  },
  rules: {
    // ─── IMMUTABLE RULES ────────────────────────────────────────────────────
    // These rules MUST NOT be disabled via eslint-disable comments.
    // See docs/WORKFLOW.md §3.3.
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/strict-boolean-expressions': [
      'error',
      {
        allowString: false,
        allowNumber: false,
        allowNullableObject: false,
      },
    ],
    'no-console': 'error',
    'import/no-cycle': ['error', { maxDepth: Infinity, ignoreExternal: true }],
    // ─── END IMMUTABLE RULES ────────────────────────────────────────────────

    // TypeScript strict rules
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'error',
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/prefer-optional-chain': 'error',
    '@typescript-eslint/no-unnecessary-condition': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-misused-promises': [
      'error',
      { checksVoidReturn: { attributes: false } },
    ],
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/consistent-type-exports': 'error',

    // Import rules
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    'import/no-duplicates': 'error',
    'import/no-unused-modules': ['warn', { unusedExports: true }],

    // General quality rules
    'eqeqeq': ['error', 'always'],
    'no-var': 'error',
    'prefer-const': 'error',
    'prefer-template': 'error',
    'no-throw-literal': 'error',
  },
  overrides: [
    // React-specific rules for web app
    // parserOptions overrides to use tsconfig.eslint.json — Next.js uses
    // moduleResolution: bundler which @typescript-eslint/parser does not support.
    // tsconfig.eslint.json uses moduleResolution: node for correct type inference.
    {
      files: ['apps/web/**/*.{ts,tsx}'],
      parserOptions: {
        project: ['./apps/web/tsconfig.eslint.json'],
        tsconfigRootDir: __dirname,
      },
      extends: ['plugin:react/recommended', 'plugin:react-hooks/recommended'],
      rules: {
        'react/prop-types': 'off',
        'react/react-in-jsx-scope': 'off',
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'error',
      },
    },
    // Backend: Node.js specific
    {
      files: ['apps/backend/**/*.ts'],
      rules: {
        // Allow process.env in backend (not in shared or frontend)
        'no-process-env': 'off',
      },
    },
    // packages/shared: extra strict — no runtime logic allowed
    {
      files: ['packages/shared/**/*.ts'],
      rules: {
        'import/no-extraneous-dependencies': [
          'error',
          {
            devDependencies: false,
            optionalDependencies: false,
            peerDependencies: false,
          },
        ],
      },
    },
    // Test files: relax certain rules that don't apply
    {
      files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'warn', // Test mocks sometimes need any
        '@typescript-eslint/no-non-null-assertion': 'warn',
        'no-console': 'off', // Allow console in tests
      },
    },
  ],
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    '.next/',
    'coverage/',
    'playwright-report/',
    '*.d.ts',
    '**/*.config.js', // Build configs use CJS/any freely
  ],
};
