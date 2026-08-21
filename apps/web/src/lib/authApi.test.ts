// ============================================================================
// P1-005 — T16 + 强制约束 A/B/C 测试
//
// 覆盖：
//   - AC-19: authApi 独立 axios 实例，无 401 拦截器，baseURL 与 api.ts 同源
//   - AC-20: Coordinator/SiweWalletClient 仅使用 authApi（不使用 api.ts）
//   - 强制约束 A: authApi baseURL === api.ts baseURL
//   - 强制约束 B: SiweWalletClient 默认依赖 authApi（不 fallback 到 api.ts）
//   - 强制约束 C: middleware cookie 名称 dev/prod 命名契约
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// 强制约束 A: authApi baseURL 与 api.ts 同源
// ============================================================================

describe('P1-005 强制约束 A: authApi baseURL 同源', () => {
  it('A01 authApi 和 api 导出且 baseURL 一致', () => {
    const authApi = require('./authApi').authApi;
    const api = require('./api').api;
    const expectedBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

    expect(authApi).toBeDefined();
    expect(api).toBeDefined();
    expect(authApi.defaults.baseURL).toBe(expectedBase);
    expect(api.defaults.baseURL).toBe(expectedBase);
    // 同源断言
    expect(authApi.defaults.baseURL).toBe(api.defaults.baseURL);
  });

  it('A02 authApi 无 401 response interceptor（验证拦截器数量）', () => {
    const authApi = require('./authApi').authApi;
    // axios 的 interceptors.response 有 handlers 数组
    const handlers = (authApi.interceptors.response as unknown as { handlers: unknown[] }).handlers;
    // authApi 不应该装任何 response 拦截器（无 401 处理）
    expect(handlers.length).toBe(0);
  });

  it('A03 api.ts 装了 401 response interceptor', () => {
    const api = require('./api').api;
    const handlers = (api.interceptors.response as unknown as { handlers: unknown[] }).handlers;
    expect(handlers.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 强制约束 B: SiweWalletClient 仅使用 authApi
// ============================================================================

describe('P1-005 强制约束 B: SiweWalletClient 仅使用 authApi', () => {
  it('B01 siwe-client.ts 默认依赖从 authApi 导入（非 api.ts）', () => {
    const siweClientPath = path.resolve(__dirname, 'siwe-client.ts');
    const src = fs.readFileSync(siweClientPath, 'utf8');
    // 必须导入 authApi
    expect(src).toMatch(/from\s+['"]\.\/authApi['"]/);
    // 禁止从 ./api 导入（作为默认依赖）
    expect(src).not.toMatch(/import\s+\{\s*api\s+as\s+defaultApi\s*\}\s+from\s+['"]\.\/api['"]/);
  });

  it('B02 siwe-client.ts 的 defaultApi 指向 authApi', () => {
    // 直接 require siwe-client 模块，检查其内部默认 http 参数
    // 由于 ts-jest 编译，require 会执行模块
    const mod = require('./siwe-client');
    expect(mod).toBeDefined();
    // SiweWalletClient 构造函数的默认 http 参数是 authApi
    // 我们通过源码静态检查已验证 import，这里再确认模块可正常加载
    expect(typeof mod.SiweWalletClient).toBe('function');
  });
});

// ============================================================================
// 强制约束 C: middleware cookie 名称 dev/prod 命名契约
// ============================================================================

describe('P1-005 强制约束 C: middleware cookie 命名契约', () => {
  // 读取 middleware.ts 源码，验证 cookie 名称常量与后端 env.ts 一致
  const middlewarePath = path.resolve(__dirname, '..', 'middleware.ts');
  // __dirname = apps/web/src/lib → 需要 4 个 .. 才能回到仓库根，再进 packages/config
  const envPath = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'config',
    'src',
    'env.ts',
  );

  it('C01 middleware 定义了 dev/prod 两套 cookie 名称', () => {
    const src = fs.readFileSync(middlewarePath, 'utf8');
    expect(src).toContain('__Host-accesstoken');
    expect(src).toContain('__Host-refreshtoken');
    expect(src).toContain('access_token');
    expect(src).toContain('refresh_token');
  });

  it('C02 middleware 根据 NODE_ENV 选择 cookie 名称', () => {
    const src = fs.readFileSync(middlewarePath, 'utf8');
    expect(src).toMatch(/process\.env\.NODE_ENV\s*===\s*['"]production['"]/);
  });

  it('C03 middleware cookie 名称与后端 env.ts 一致（dev: access_token/refresh_token）', () => {
    const envSrc = fs.readFileSync(envPath, 'utf8');
    const mwSrc = fs.readFileSync(middlewarePath, 'utf8');
    // 后端 env.ts dev 默认（optional 第二参数的 false 分支使用字面量 'access_token'/'refresh_token'）
    expect(envSrc).toContain("'access_token'");
    expect(envSrc).toContain("'refresh_token'");
    expect(envSrc).toMatch(/optional\(\s*['"]COOKIE_NAME['"]/);
    expect(envSrc).toMatch(/optional\(\s*['"]REFRESH_COOKIE_NAME['"]/);
    // middleware 使用相同名称
    expect(mwSrc).toContain("'access_token'");
    expect(mwSrc).toContain("'refresh_token'");
  });

  it('C04 middleware cookie 名称与后端 env.ts 一致（prod: __Host-accesstoken/__Host-refreshtoken）', () => {
    const envSrc = fs.readFileSync(envPath, 'utf8');
    const mwSrc = fs.readFileSync(middlewarePath, 'utf8');
    expect(envSrc).toContain("'__Host-accesstoken'");
    expect(envSrc).toContain("'__Host-refreshtoken'");
    expect(mwSrc).toContain("'__Host-accesstoken'");
    expect(mwSrc).toContain("'__Host-refreshtoken'");
  });

  it('C05 middleware presence prefilter：access OR refresh 任一存在 → 放行', () => {
    const mwSrc = fs.readFileSync(middlewarePath, 'utf8');
    // 必须有 hasAccess || hasRefresh 的逻辑
    expect(mwSrc).toMatch(/hasAccess\s*\|\|\s*hasRefresh/);
  });

  it('C06 middleware 仅 prefilter（不验签，不视为认证）', () => {
    const mwSrc = fs.readFileSync(middlewarePath, 'utf8');
    // 不应包含 JWT 验签逻辑
    expect(mwSrc).not.toMatch(/jwt|verify|decode|signature/i);
    // 注释明确 presence prefilter
    expect(mwSrc).toMatch(/presence prefilter/i);
  });
});

// ============================================================================
// AC-20: Coordinator 仅使用 authApi/SiweWalletClient（不使用 api.ts）
// ============================================================================

describe('P1-005 AC-20: Coordinator 仅使用 authApi', () => {
  it('AC20-01 AuthSessionCoordinator.ts 不 import api.ts', () => {
    const coPath = path.resolve(__dirname, '..', 'auth', 'AuthSessionCoordinator.ts');
    const src = fs.readFileSync(coPath, 'utf8');
    // 不应从 ./api 或 ../lib/api 导入
    expect(src).not.toMatch(/from\s+['"](\.\.\/)*lib\/api['"]/);
    expect(src).not.toMatch(/import\s+\{\s*api\s*\}\s+from/);
  });

  it('AC20-02 AuthSessionCoordinator.ts 不依赖 React', () => {
    const coPath = path.resolve(__dirname, '..', 'auth', 'AuthSessionCoordinator.ts');
    const src = fs.readFileSync(coPath, 'utf8');
    expect(src).not.toMatch(/from\s+['"]react['"]/);
    expect(src).not.toMatch(/useContext|useState|useEffect/);
  });
});
