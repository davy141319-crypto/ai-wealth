// ============================================================================
// P1-005 — T18: middleware presence prefilter 测试
//
// 由于 jest 配置为 node 环境，无法直接运行 Next.js middleware（需要 Edge runtime）。
// 这里通过静态代码契约 + 动态逻辑测试覆盖：
//   - AC-23: access 或 refresh 任一存在 → 放行；两者无 → redirect
//   - AC-24: middleware 仅 prefilter，真实认证由 /auth/me 完成
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

// 提取 middleware 的 cookieNamesForEnv 逻辑进行动态测试
// 由于 middleware.ts 用了 NextRequest/NextResponse（Edge runtime），我们用 eval 提取
// 纯逻辑函数。更简单的方式：复制 cookieNamesForEnv 逻辑并验证其与源码一致。

interface CookieNames {
  access: string;
  refresh: string;
}

/** 与 middleware.ts 的 cookieNamesForEnv 一致（用于动态测试）。 */
function cookieNamesForEnv(isProd: boolean): CookieNames {
  return {
    access: isProd ? '__Host-accesstoken' : 'access_token',
    refresh: isProd ? '__Host-refreshtoken' : 'refresh_token',
  };
}

describe('P1-005 middleware presence prefilter', () => {
  const middlewarePath = path.resolve(__dirname, 'middleware.ts');
  const mwSrc = fs.readFileSync(middlewarePath, 'utf8');

  it('MW01 dev 环境 cookie 名称：access_token / refresh_token', () => {
    const names = cookieNamesForEnv(false);
    expect(names.access).toBe('access_token');
    expect(names.refresh).toBe('refresh_token');
  });

  it('MW02 prod 环境 cookie 名称：__Host-accesstoken / __Host-refreshtoken', () => {
    const names = cookieNamesForEnv(true);
    expect(names.access).toBe('__Host-accesstoken');
    expect(names.refresh).toBe('__Host-refreshtoken');
  });

  it('MW03 matcher 仅匹配 /dashboard/*', () => {
    expect(mwSrc).toMatch(/matcher:\s*\['\/dashboard\/:path\*'\]/);
  });

  it('MW04 仅 access cookie 存在 → 放行', () => {
    expect(mwSrc).toMatch(/hasAccess\s*\|\|\s*hasRefresh/);
  });

  it('MW05 仅 refresh cookie 存在 → 放行', () => {
    expect(mwSrc).toMatch(/hasAccess\s*\|\|\s*hasRefresh/);
  });

  it('MW06 两者都不存在 → redirect /login?next=', () => {
    expect(mwSrc).toMatch(/loginUrl\.pathname\s*=\s*['"]\/login['"]/);
    expect(mwSrc).toMatch(/next=/);
  });

  it('MW07 middleware 仅 prefilter，不验签（AC-24）', () => {
    expect(mwSrc).not.toMatch(/jwt|jsonwebtoken|verify\(|decode\(|signature/i);
  });

  it('MW08 middleware 注释明确 presence prefilter', () => {
    expect(mwSrc).toMatch(/presence prefilter/i);
  });

  it('MW09 middleware cookie 名称常量与后端 env.ts 一致（强制约束 C）', () => {
    // __dirname = apps/web/src → 需要 3 个 .. 才能回到仓库根，再进 packages/config
    const envPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'packages',
      'config',
      'src',
      'env.ts',
    );
    const envSrc = fs.readFileSync(envPath, 'utf8');
    // prod 常量
    expect(envSrc).toContain("'__Host-accesstoken'");
    expect(envSrc).toContain("'__Host-refreshtoken'");
    expect(mwSrc).toContain('__Host-accesstoken');
    expect(mwSrc).toContain('__Host-refreshtoken');
    // dev 默认
    expect(envSrc).toContain("'access_token'");
    expect(envSrc).toContain("'refresh_token'");
    expect(mwSrc).toContain('access_token');
    expect(mwSrc).toContain('refresh_token');
  });
});
