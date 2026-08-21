# P1-004 Tasks

不修改：JwtAuthService / SIWE / Nonce / Repository / migration / 原 T01-T15 + C01-C11 断言。
Audit 窄豁免（沿用 P1-003）：仅 additive 新增 refresh 审计方法。
不新增 DB 表/migration —— 全 Redis + TTL。

## 任务

1. spec.md + tasks.md 写入 + 批准 ✅
2. env.ts：refreshCookieName / familyMaxLifetimeSec(30d) / reuseGraceSec(30) /
   maxRefreshRetry(2) + 生产 fail-fast；复用 WEB_APP_URL/ADMIN_APP_URL 作 Origin allowlist
3. shared 枚举：REFRESH_TOKEN_INVALID / REUSED / REVOKED / RETRY /
   TRANSPORT_REQUIRED / TRANSPORT_ORIGIN_CONFLICT / TRANSPORT_COOKIE_CONFLICT /
   ORIGIN_NOT_ALLOWED + AUTH_REFRESH_SUCCESS/FAILURE/REUSE/SESSION_REVOKED/
   BODY_IGNORED/TRANSPORT_CONFLICT
4. Redis Lua 原子 rotation 脚本（5 态 + 撤销原子 + 旧 lookup 保留 + TTL=familyExpiresAt-now）
5. RefreshTokenService：issueFamily(设 familyExpiresAt) / rotate(Lua) / revokeFamily /
   verifyRefreshToken / hashToken / generateOpaque(48 bytes base64url)
6. TransportMiddleware：X-Auth-Transport + Origin/Referer allowlist × transport 矩阵 +
   约束 A（api+cookie→403 TRANSPORT_COOKIE_CONFLICT 在 CSRF 前）
7. CsrfGuard 修订：触发 = access OR refresh cookie 存在
8. LogoutGuard（约束 B）：access OR refresh 任一有效；不抛 401；附加 req.logoutCredentials
   供 Controller 继续
9. POST /auth/refresh endpoint + DTO + transport 分流 + Cookie 优先 + body 忽略
10. SIWE verify 扩展：签发首个 refresh token + transport 响应分流 + login-CSRF Origin 校验
11. logout 扩展：Controller 先清三 cookie 再返回（按凭证状态）+ 撤销 family（约束 B）
12. CookieAuthService 扩展：refresh cookie set/clear（Max-Age=family剩余寿命）
13. siwe-client 适配：X-Auth-Transport: cookie + refresh + 409 用 access + 401 重登录
14. FakeRedisService 扩展：eval mock + TTL 模拟
15. 测试 R01-R29 + 回归 T01-T15 + C01-C11
16. CI/CodeQL 验收 + PR→develop（不 Merge）

## 验收

- 每完成一项先 lint/typecheck/test 再继续
- 发 Spec 冲突立即 STOP 报告
- 最终 Lint/Typecheck/Test/Build/Secret/Docker/CI Gate/CodeQL 全绿 → PR → develop（不自行 Merge）

## 约束 A & B 强制执行点

- 约束 A（任务 6）：TransportMiddleware 在 CsrfGuard 之前执行；api 模式 + cookie 存在 → 403
- 约束 B（任务 8 + 11）：LogoutGuard 不抛 401；Controller 先清 cookie 再返回
- 测试：R11（cookie logout 均无效→清cookie+401）、R29（api+cookie→403）

## SPEC STATUS: LOCKED / READY FOR IMPLEMENTATION
