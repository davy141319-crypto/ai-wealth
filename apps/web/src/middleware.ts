// ============================================================================
// P1-005 — Next.js Edge middleware (presence prefilter)
//
// ⚠️ 这是 presence prefilter，不是认证（spec v3 修订）：
//   - access cookie 存在 OR refresh cookie 存在 → 放行（允许进入页面壳）
//     真实认证由 AuthProvider /auth/me 在客户端完成
//   - 两者都不存在 → redirect /login?next=<original>
//
// 强制约束 C：cookie 名称必须与后端实际 Cookie 配置一致（env.ts）：
//   - dev (NODE_ENV !== 'production'): access_token / refresh_token
//   - prod (NODE_ENV === 'production'): __Host-accesstoken / __Host-refreshtoken
//
// 注意：Next.js middleware 运行在 Edge runtime，无法 import 后端 env.ts
// （它依赖 Prisma 等 Node-only 模块），所以这里硬编码与 env.ts 相同的命名契约，
// 并通过单元测试 middleware-cookie-contract.test.ts 锁定双方一致。
// ============================================================================

import { NextResponse, type NextRequest } from 'next/server';

/** 与 packages/config/src/env.ts 的 PROD_*_COOKIE_NAME 保持一致。 */
const PROD_ACCESS_COOKIE = '__Host-accesstoken';
const PROD_REFRESH_COOKIE = '__Host-refreshtoken';
const DEV_ACCESS_COOKIE = 'access_token';
const DEV_REFRESH_COOKIE = 'refresh_token';

/** 受保护路径前缀。matcher 也会排除 /login / / /_next / /api。 */
const PROTECTED_PREFIX = '/dashboard';

function cookieNamesForEnv(): { access: string; refresh: string } {
  // Next.js middleware 的 process.env.NODE_ENV 由 next build/start 决定。
  // dev (next dev) → 'development'；prod (next build && next start) → 'production'。
  const isProd = process.env.NODE_ENV === 'production';
  return {
    access: isProd ? PROD_ACCESS_COOKIE : DEV_ACCESS_COOKIE,
    refresh: isProd ? PROD_REFRESH_COOKIE : DEV_REFRESH_COOKIE,
  };
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 仅 /dashboard/* 做 prefilter（matcher 已限定，这里二次保险）
  if (!pathname.startsWith(PROTECTED_PREFIX)) {
    return NextResponse.next();
  }

  const names = cookieNamesForEnv();
  const hasAccess = Boolean(request.cookies.get(names.access)?.value);
  const hasRefresh = Boolean(request.cookies.get(names.refresh)?.value);

  // access 或 refresh 任一存在 → 放行（允许进入页面壳，AuthProvider /me 做真实认证）
  if (hasAccess || hasRefresh) {
    return NextResponse.next();
  }

  // 两者都不存在 → redirect /login?next=<original>
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = `?next=${encodeURIComponent(pathname + (request.nextUrl.search || ''))}`;
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // 匹配 /dashboard/*，排除 /login / / /_next / /api
  matcher: ['/dashboard/:path*'],
};
