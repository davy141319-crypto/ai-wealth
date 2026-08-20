module.exports = {
  extends: '../../.eslintrc.base.cjs',
  parserOptions: { project: './tsconfig.json', ecmaFeatures: { jsx: true } },
  settings: { react: { version: 'detect' } },
};
