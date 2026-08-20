/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  moduleNameMapper: {
    '^@ai-wealth/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@ai-wealth/config$': '<rootDir>/../../packages/config/src/index.ts',
    '^@ai-wealth/database$': '<rootDir>/../../packages/database/src/index.ts',
  },
};
