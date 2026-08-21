/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // P1-005: 同时匹配 .test.ts 和 .test.tsx（AuthProvider 等测试）
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  // P1-005 修订（Fix 4）：显式声明 ts-jest 同时处理 .ts 与 .tsx（含 JSX），
  // 否则默认 transform 只命中 .ts，.tsx 的 JSX 报 "Unexpected token '<'"。
  // tsconfig.test.json 覆盖 jsx 为 "react"（主 tsconfig 用 "preserve" 供 Next.js，但
  // ts-jest 在 preserve 模式下不会转换 JSX → jest-runtime 报 SyntaxError）。
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
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
