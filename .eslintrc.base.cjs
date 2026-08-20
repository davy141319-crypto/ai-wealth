/**
 * AI Wealth DApp — shared ESLint base config (ESLint 8 legacy config).
 * Each package extends this via: "extends": "../../.eslintrc.base.cjs"
 */
module.exports = {
  root: false,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    // Strictness
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always'],
    'no-return-await': 'error',
    // Keep P0 clean but not blocking: prefer-const etc.
    'prefer-const': 'error',
    'no-var': 'error',
  },
  ignorePatterns: ['dist/', 'build/', 'out/', '.next/', 'node_modules/', 'coverage/'],
};
