module.exports = {
  extends: ['../../.eslintrc.base.cjs', 'plugin:react/recommended', 'plugin:react-hooks/recommended'],
  parserOptions: {
    project: './tsconfig.json',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['react'],
  settings: { react: { version: 'detect' } },
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
  },
};
