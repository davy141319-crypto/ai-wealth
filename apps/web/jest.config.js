/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@ai-wealth/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@ai-wealth/config$': '<rootDir>/../../packages/config/src/index.ts',
    '^@ai-wealth/ui$': '<rootDir>/../../packages/ui/src/index.ts',
  },
};
