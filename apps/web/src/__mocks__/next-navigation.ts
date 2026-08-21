// Mock for next/navigation in tests.
// 提供一个可被测试断言/重置的 mock router（P1-005 集成测试用）。
export const mockRouter = {
  replace: jest.fn(),
  push: jest.fn(),
  back: jest.fn(),
  refresh: jest.fn(),
  prefetch: jest.fn(),
};

export function useRouter() {
  return mockRouter;
}

export function usePathname() {
  return '/dashboard';
}

export function useSearchParams() {
  return new URLSearchParams();
}

/** 重置 mock router 的调用记录（beforeEach 调用）。 */
export function __resetMockRouter(): void {
  mockRouter.replace = jest.fn();
  mockRouter.push = jest.fn();
  mockRouter.back = jest.fn();
  mockRouter.refresh = jest.fn();
  mockRouter.prefetch = jest.fn();
}
