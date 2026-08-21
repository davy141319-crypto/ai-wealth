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

## v5+ FINAL FIX（3 项修复）

- **修复 1**（legacy 删除）:
  - `transport.middleware.ts`: 删除 `legacy` 分支；`/verify`、`/refresh`、`/logout` 缺失/非法 `X-Auth-Transport` 均 400 `TRANSPORT_REQUIRED`
  - `auth.controller.ts`: /verify 删除 dual-mode 第三分支（不同时 set cookie 又 body 返回 token）；/logout 删除 legacy 兼容分支
  - `auth.siwe.test.ts` (T01-T15): `verify()` helper 补 `X-Auth-Transport: api`；T13/T15 logout 补 `X-Auth-Transport: api`
  - `auth.cookie-csrf.test.ts` (C01-C11): `verify()`/`login()` helper 支持 transport 参数（cookie 默认，C04/C07 用 api）；C05/C06/C09 logout 补 `X-Auth-Transport: cookie` + Origin；C08 补 `X-Auth-Transport: api`
  - 原断言不改
- **修复 2**（409 仅清 refresh cookie）:
  - `cookie-auth.service.ts`: 新增 `clearRefreshCookie(res)` 方法（仅清 refresh cookie，Max-Age=0 + Expires=epoch）
  - `auth.controller.ts`: /refresh retry 分支改用 `clearRefreshCookie`（原 `clearAuthCookies` 清三个）
  - 新增 R30 测试：验证 409 后 access cookie 未清 + access JWT 仍可认证 /me
- **修复 3**（Lua 脚本 dist 验证）:
  - `nest-cli.json`: 配置 `compilerOptions.assets` 将 `**/*.lua` 复制到 dist
  - 新增 R31 测试：静态契约检查（源文件 + nest-cli.json assets glob + 服务读取 basename 一致），不依赖 CI build 作业先行
  - CI ci.yml build job: 新增 `test -f services/api/dist/auth/refresh-rotation.lua` 动态验证
  - Dockerfile.api: 新增 `RUN test -f services/api/dist/auth/refresh-rotation.lua` 动态验证

## v6（2 项 P0 修复）

- **P0-1**（禁止 wallets[0] 创建 family）:
  - `auth.service.ts`: `VerifySuccess` 接口 additive 新增 `verifiedWalletId: string`（本次 SIWE 已验证的 walletId）；`verify()` 返回 `verifiedWalletId: wallet.id`
  - `auth.controller.ts`: /verify 改用 `result.verifiedWalletId` 替代 `result.user.wallets[0]?.id ?? ''`
  - `refresh-token.service.ts`: `issueFamily` 新增空 walletId 校验（空值抛 `WALLET_ID_REQUIRED`）
  - 不得改 JwtAuthService/SIWE/Nonce/Repository
- **P0-2**（保持 SIWE 绝对过期边界）:
  - `auth.service.ts`: `VerifySuccess` 接口 additive 新增 `authorizationExpiresAt: string | null`（`parsed.expirationTime`）
  - `refresh-token.service.ts`: `FamilyMeta` 新增 `authorizationExpiresAt: number | null`；`issueFamily` 接受 `authorizationExpiresAt?` 参数；`familyExpiresAt = min(now + familyMaxLifetimeSec, authorizationExpiresAt)`
  - `auth.controller.ts`: /refresh 中 `jwtAuth.sign` 传入 `absoluteExpiresAtIso`（从 family.authorizationExpiresAt 转换），确保 access JWT 不越过原 SIWE 授权期限
  - `fake-redis.service.ts`: runScript 解析 fam 时保留 `authorizationExpiresAt` 字段（revoke 分支重新序列化不丢失）
- **新增测试**:
  - R32: 多钱包登录 → family walletId = B（不是 wallets[0]）；refresh 后 access JWT walletId = B
  - R33: SIWE exp < 30d → familyExpiresAt ≤ SIWE exp；refresh 后 access exp ≤ SIWE exp
  - R34: 无 SIWE exp → family 仍最大 30d（authorizationExpiresAt=null）
  - R10/R26: 调整 SIWE exp 使其长于 fast-forward 时间（适应 v6 familyExpiresAt 受 SIWE exp 约束的新行为）；断言不改
- **同步 spec/PR body**: 删除 legacy 描述；更新测试数量（59→64）；更新 AC-34/35/36
