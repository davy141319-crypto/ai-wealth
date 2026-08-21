/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // P1-005: 同时匹配 .test.ts 和 .test.tsx（AuthProvider 等测试）
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@ai-wealth/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@ai-wealth/config$': '<rootDir>/../../packages/config/src/index.ts',
    '^@ai-wealth/ui$': '<rootDir>/../../packages/ui/src/index.ts',
    // 测试中 mock 掉 next/navigation 和 wagmi（避免引入 jsdom）
    '^next/navigation$': '<rootDir>/src/__mocks__/next-navigation.ts',
    '^next/server$': '<rootDir>/src/__mocks__/next-server.ts',
    '^wagmi$': '<rootDir>/src/__mocks__/wagmi.ts',
  },
};
