# P1-003 HttpOnly Cookie Session + DSC CSRF + Bearer/Cookie Dual Mode - Product Requirements Document

## Overview

- **Summary**: 在 develop HEAD `5c3e0324d26a2236f7098d478bc89a1b8a1a9b53`（P1-002 已合并）基线上，为 P1-002 的 Bearer Header 认证新增 HttpOnly Cookie 会话投递与 Double Submit Cookie (DSC) CSRF 防护，形成"浏览器友好 + 防 XSS 偷 token + 防 CSRF"的生产级会话层；保持 Bearer 模式向后兼容。
- **Purpose**: 让浏览器前端通过 HttpOnly Cookie 自动携带会话 token（前端 JS 不可读，防 XSS 偷 token），同时用 DSC 防止跨站伪造请求；非浏览器客户端（API 集成 / 测试）继续使用 Bearer Header。
- **Target Users**: Web DApp 浏览器用户（Cookie 模式）；API 集成客户端与测试（Bearer 模式）。

## Baseline (verified against real P1-002 code)

| 现状                | 事实                                                                    | 出处                             |
| ------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| CORS                | 已 `credentials: true` + 白名单 `[webAppUrl, adminAppUrl]`              | services/api/src/main.ts:23-27   |
| cookie-parser       | 未启用                                                                  | main.ts 全文无                   |
| Swagger Auth        | 仅 `addBearerAuth()`                                                    | main.ts:50                       |
| Guard 来源          | 仅读 `Authorization: Bearer`；无即抛 `NOT_AUTHENTICATED`；从不读 cookie | jwt-auth.guard.ts:33-37          |
| JwtAuthService 定位 | 注释明示 "never reads from cookie (P1-002 scope)"                       | jwt-auth.service.ts:8            |
| verify 响应         | body 返回 `{accessToken, user}`，无 Set-Cookie                          | auth.controller.ts:106-121       |
| logout              | 仅 `jwtAuth.revoke()` + 审计，无 cookie 清除                            | auth.controller.ts:164-172       |
| Guard 部署          | 路由级 `@UseGuards(JwtAuthGuard)`（me/logout），非 APP_GUARD            | auth.module.ts:84-88             |
| AuthContext         | `{userId, walletId?, jti, token}` 挂 `req.auth`                         | jwt-auth.guard.ts:18-23,51-56    |
| Redis 会话          | `auth:sessions:<jti>` + `auth:blocked:<jti>`，HS256                     | jwt-auth.service.ts:34-35,82-139 |

**结论**：CORS `credentials: true` 已满足 Cookie 投递前置条件；需补齐 cookie-parser、双源 Guard、verify set-cookie、logout 清 cookie、CSRF Guard。

## Goals

- [G-1] HttpOnly Cookie Session：verify 成功投递 access cookie（生产 `__Host-accesstoken`）；logout 清除 cookie。
- [G-2] Double Submit Cookie CSRF：状态变更请求（POST/PUT/PATCH/DELETE）且存在 access cookie 时校验 `X-CSRF-TOKEN` header == csrf cookie；Bearer-only 请求无需 CSRF。
- [G-3] Bearer + Cookie 双模式 Guard：Bearer 优先，Cookie 回落；`AuthContext` 结构不变。
- [G-4] `GET /api/auth/csrf-token`：返回 csrf token + set csrf cookie。
- [G-5] 向后兼容：P1-002 原 15 项测试（T01-T15）断言不改、全 PASS。
- [G-6] 不修改数据库 / migration / JwtAuthService / SIWE / Nonce / Audit / Repository。
- [G-7] CI 全绿（Lint/Typecheck/Test/Build/Secret/Docker/CI Gate/CodeQL Analyze/Code scanning）。

## Non-Goals (OUT-OF-SCOPE)

- ❌ Refresh Token rotation（→ 后续阶段）
- ❌ Admin RBAC（→ 后续独立阶段）
- ❌ TRON SIWE（→ 独立任务）
- ❌ 完整登录 UI 视觉（→ 单独定义；P1-003 仅 siwe-client.ts lib 适配）
- ❌ 任何资金业务（USDT/充值/提现/理财/收益/积分/任务/邀请/团队/V1-V5/博彩/体育/电竞/彩票/真人娱乐，硬约束永久禁止）

## Do Not Touch

- 数据库 schema + 所有 migration（P1-001/P1-002 已验收）
- `services/api/src/auth/jwt-auth.service.ts`（仅复用 sign/verify/revoke，不改内部）
- `services/api/src/auth/siwe.service.ts`、`nonce.service.ts`（仅复用；`audit.service.ts` 见下方「Approved Narrow Exemption」窄豁免）
- `packages/database/src/repositories/*`（已验收）
- P1-002 原 15 项测试断言（仅追加，不改原有）

## Functional Requirements

### FR-1 Cookie 环境配置

- `packages/config/src/env.ts` 新增字段：`cookieName`、`csrfCookieName`、`cookieDomain`、`cookieSecure`、`cookieSameSite`、`cookiePath`、`csrfHeaderName`。
- 默认值：生产（NODE_ENV=production）`cookieName=__Host-accesstoken`、`csrfCookieName=__Host-csrf`、`cookieSecure=true`、`cookieSameSite=Lax`、`cookiePath=/`、`cookieDomain` 不设置；开发/测试 `cookieName=access_token`、`csrfCookieName=csrf`、`cookieSecure=false`。

### FR-2 cookie-parser + CookieAuthService

- `services/api/src/main.ts` 在 helmet 之后启用 `app.use(cookieParser())`。
- 新增 `services/api/src/auth/cookie-auth.service.ts`：
  - `setAuthCookie(res, token)`：set access cookie（HttpOnly=true, Secure/SameSite/Path/Domain 按 env）。Max-Age 从已签发 JWT 的 `exp` claim 解码计算（非配置 TTL 推算），确保 Cookie 与 token 实际过期同步（含 SIWE expirationTime 更短时 JwtAuthService 已 clamp exp，Cookie 自动跟随）。
  - `clearAuthCookies(res)`：清 access + csrf cookie，同时输出 `Max-Age=0` + `Expires=epoch`（手动构造 Set-Cookie 头，绕过 Express res.clearCookie 的 maxAge/expires 互斥），Path/Domain 与设置时一致。

### FR-3 DSC CSRF

- 新增 `services/api/src/auth/csrf.service.ts`：`generateToken()` 返回 `crypto.randomBytes(32).toString('base64url')`。
- 新增 `services/api/src/auth/csrf.guard.ts`：
  - 仅对 POST/PUT/PATCH/DELETE 生效。
  - **仅当请求存在 access cookie 时校验**（Bearer-only 无 cookie 请求豁免）。
  - 校验 `header[X-CSRF-TOKEN] === cookie[csrfCookieName]` 且非空 → 否则 403 `CSRF_TOKEN_INVALID` + 审计 `AUTH_CSRF_FAILURE`。
  - 豁免路径：`/api/auth/nonce`、`/api/auth/verify`、`/api/auth/csrf-token`（verify 虽 POST 但登录前无 session）。
- 新增 `GET /api/auth/csrf-token`：返回 `{csrfToken}` + set csrf cookie（HttpOnly=false, Secure, SameSite=Lax, Path=/）。
- **logout 使用 Cookie 时必须 CSRF**：logout 非豁免路径，使用 cookie 鉴权时需带 X-CSRF-TOKEN。

### FR-4 Bearer/Cookie 双模式 Guard（Bearer 优先）

- 修改 `services/api/src/auth/jwt-auth.guard.ts`：
  1. 读 `Authorization: Bearer` header
  2. 存在 → 用 Bearer（Bearer 优先）
  3. 否则读 `req.cookies[cookieName]` → 用 Cookie
  4. 两者都无 → 抛 `NOT_AUTHENTICATED`
  5. 调 `JwtAuthService.verify(token)`（逻辑不变）
  6. 挂 `req.auth = {userId, walletId, jti, token}`（结构不变）
- 双源同时存在：Bearer 优先，Cookie token 不撤销，debug 日志"使用 Bearer"（不记 token 原文）。

### FR-5 verify set-cookie / logout 清 cookie

- `postVerify`：注入 `@Res({ passthrough: true })`，verify 成功后调 `CookieAuthService.setAuthCookie(res, token, expSec)`；响应 body 仍含 `accessToken`（Bearer 兼容）。
- `postLogout`：注入 `@Res({ passthrough: true })`，`jwtAuth.revoke()` + 审计不变，新增 `CookieAuthService.clearAuthCookies(res)`。

### FR-6 前端 siwe-client.ts 适配

- `apps/web/src/lib/siwe-client.ts`：fetch 改 `credentials: 'include'`；登录前调 `GET /api/auth/csrf-token` 存 token；状态变更请求附加 `X-CSRF-TOKEN` header。
- 不做登录页 UI 视觉打磨（范围外）。

## Cookie Attributes

### Access Cookie

| 属性     | 生产                                                                           | 开发/测试      |
| -------- | ------------------------------------------------------------------------------ | -------------- |
| Name     | `__Host-accesstoken`                                                           | `access_token` |
| Value    | JWT 原文（复用 `JwtAuthService.sign()` 输出）                                  |
| HttpOnly | `true`                                                                         | `true`         |
| Secure   | `true`                                                                         | `false`        |
| SameSite | `Lax`                                                                          | `Lax`          |
| Path     | `/`                                                                            | `/`            |
| Domain   | 不设置                                                                         | 不设置         |
| Max-Age  | 按已签发 JWT 实际 `exp` 计算（解码 token payload），非配置 `jwtExpiresIn` 推算 |

### CSRF Cookie

| 属性                     | 生产                        | 开发/测试 |
| ------------------------ | --------------------------- | --------- |
| Name                     | `__Host-csrf`               | `csrf`    |
| Value                    | 32 字节随机 token base64url |
| HttpOnly                 | `false`（前端 JS 需读取）   | `false`   |
| Secure / SameSite / Path | 同 access cookie            |

## Security Requirements

- Token 不进 URL / localStorage / log。
- access cookie HttpOnly（JS 不可读）；CSRF cookie 非 HttpOnly 但仅是随机 token 无敏感信息。
- 生产 cookie 强制 Secure + HttpOnly + SameSite=Lax；`__Host-` 前缀绑定 host。
- CSRF 失败写 `AUTH_CSRF_FAILURE` 审计（actor=null）；不泄漏 cookie/header 内容。
- CORS 保持白名单 + `credentials:true`；不允许 `*`。
- Bearer 优先；双源不混淆。
- CodeQL 规避：CSRF token 用 `crypto.randomBytes`（无低效正则）；cookie 比对不用正则（直接字符串相等）。

## API

### Modified

| METHOD | PATH               | AUTH             | 变更                                      |
| ------ | ------------------ | ---------------- | ----------------------------------------- |
| POST   | `/api/auth/verify` | 无               | +set access cookie；body 仍含 accessToken |
| GET    | `/api/auth/me`     | Bearer 或 Cookie | 双源 Guard                                |
| POST   | `/api/auth/logout` | Bearer 或 Cookie | +清 cookie；cookie 模式需 CSRF            |
| GET    | `/api/auth/nonce`  | 无               | 不变                                      |

### New

| METHOD | PATH                   | AUTH | REQUEST | RESPONSE                        |
| ------ | ---------------------- | ---- | ------- | ------------------------------- |
| GET    | `/api/auth/csrf-token` | 公开 | 无      | `{csrfToken}` + set csrf cookie |

## Database

- **数据库无需修改**。access_token 仍是 P1-002 JWT；CSRF 用 DSC 不落库；会话状态走 Redis（复用 `auth:sessions` / `auth:blocked`）。

## File Impact

### Modify

- `services/api/src/main.ts`（+cookie-parser）
- `services/api/src/auth/auth.controller.ts`（verify set cookie；logout 清 cookie；+GET /csrf-token）
- `services/api/src/auth/auth.module.ts`（注册 Cookie/Csrf provider）
- `services/api/src/auth/jwt-auth.guard.ts`（双源解析）
- `packages/config/src/env.ts`（cookie/csrf 配置）
- `packages/shared/src/error-codes.ts`（+CSRF_TOKEN_INVALID, +AUTH_CSRF_FAILURE）
- `apps/web/src/lib/siwe-client.ts`（credentials + CSRF）
- `services/api/package.json`（+cookie-parser, +@types/cookie-parser）

### Add

- `services/api/src/auth/cookie-auth.service.ts`
- `services/api/src/auth/csrf.service.ts`
- `services/api/src/auth/csrf.guard.ts`
- `services/api/src/auth/dto/csrf-token.dto.ts`
- `services/api/test/auth.cookie-csrf.test.ts`

### Do Not Touch

- 数据库 schema + migration
- `services/api/src/auth/jwt-auth.service.ts`、`siwe.service.ts`、`nonce.service.ts`
- `packages/database/src/repositories/*`
- P1-002 原 15 项测试断言

### Approved Narrow Exemption: AuditService (P1-003)

- 原 "Do Not Touch" 含 `audit.service.ts`。P1-003 Spec 要求 "CSRF 失败 → AUTH_CSRF_FAILURE 审计"，唯一干净实现路径是 AuditService 新增方法。经用户批准的**窄豁免**：
  - 仅允许**新增** `recordCsrfFailure({requestId, ip, userAgent})` 方法（写 `AUTH_CSRF_FAILURE`，`actor=null`，**显式传 `success: false`**）。
  - 仅允许**新增** `AuditAction.AUTH_CSRF_FAILURE` + `AuthFailReason.CSRF_TOKEN_INVALID` 枚举值（纯 additive，不改既有枚举成员）。
  - **禁止**修改 P1-002 既有 Audit 方法、`write()` 默认 `success` 语义、`recordLoginSuccess/Failure/Logout`。
  - **禁止**修改原 T01-T15 断言（回归 15/15 全 PASS）。
  - 该豁免仅限 P1-003 CSRF 审计；不延伸至其他阶段或组件。

## Acceptance Criteria

| AC    | 描述                              | Pass Condition                                                                                                                                           |
| ----- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1  | verify 成功后投递 HttpOnly Cookie | 响应含 Set-Cookie，属性正确；Max-Age == 已签发 JWT 实际 `exp`（解码 payload，非配置 TTL）                                                                |
| AC-2  | /csrf-token 端点                  | 返回 {csrfToken} + set csrf cookie（HttpOnly=false, Secure, SameSite=Lax, Path=/）                                                                       |
| AC-3  | CSRF 强制（cookie 请求）          | POST/PUT/PATCH/DELETE 携带 cookie 时无/不匹配 X-CSRF-TOKEN → 403 + 审计；GET/HEAD/OPTIONS/nonce/verify/csrf-token 豁免；Bearer-only 无 cookie 时正常通过 |
| AC-4  | 双模式 Guard                      | 仅 Bearer 200；仅 Cookie 200；Bearer+Cookie → Bearer 优先；双无 401                                                                                      |
| AC-5  | logout 清除 cookie                | access + csrf cookie 均 Max-Age=0 + Expires=epoch；Redis blocklist/session 不变                                                                          |
| AC-6  | P1-002 回归                       | 原 15 项 T01-T15 全 PASS，断言不改                                                                                                                       |
| AC-7  | 数据库零修改                      | 无新 migration；Redis 复用现有 key                                                                                                                       |
| AC-8  | JwtAuthService 不改               | 内部逻辑零修改，仅复用 sign/verify/revoke                                                                                                                |
| AC-9  | 安全                              | token 不进 URL/localStorage/log；CSRF 失败不泄漏 token                                                                                                   |
| AC-10 | CORS                              | 白名单 + credentials:true；不允许 *                                                                                                                      |
| AC-11 | CI 全绿                           | 10 项全 success                                                                                                                                          |
| AC-12 | 架构分层                          | Controller 仅路由+DTO；Cookie/CSRF 在 Service；Guard 仅校验                                                                                              |
| AC-13 | 无资金业务                        | grep 无 USDT/deposit/withdraw 业务实现                                                                                                                   |
| AC-14 | 范围外项未实现                    | 无 refresh-token / Admin RBAC / TRON / 完整登录 UI 代码                                                                                                  |
