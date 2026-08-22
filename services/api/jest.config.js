/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Single worker is required for reproducibility because several suites
  // share mutable external infrastructure:
  //   * auth/*.test.ts uses a live NestJS app + Redis (JWT/refresh token
  //     families) + writes real rows to the users/wallets tables
  //   * money-path/*integration.spec.ts and migration-appendonly.spec.ts
  //     run Serializable transactions against the same live Postgres;
  //     cross-worker predicate locks produce 40P01 deadlocks and shared
  //     user-rows (created by auth/admin.*.test.ts) collide with the
  //     money-path acquireAccountLocks SELECT ... FOR UPDATE.
  // This exactly matches GitHub Actions (2 vCPUs → jest default
  // maxWorkers = cpus - 1 = 1 worker). The small local-performance cost is
  // worth eliminating a full-class of flaky shared-DB failures.
  maxWorkers: 1,
  setupFiles: ['<rootDir>/jest.preset-env.js'],
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  moduleNameMapper: {
    '^@ai-wealth/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@ai-wealth/config$': '<rootDir>/../../packages/config/src/index.ts',
    '^@ai-wealth/database$': '<rootDir>/../../packages/database/src/index.ts',
  },
};
