# P1-003 Tasks

基线：develop HEAD `5c3e0324d26a2236f7098d478bc89a1b8a1a9b53`
分支：`feature/p1-003-cookie-csrf`（从 5c3e0324 创建）
PR base：develop
Merge：Squash and merge

排除：Refresh Token / Admin RBAC / TRON SIWE / 完整登录 UI / 任何资金业务
不修改：数据库 / migration / JwtAuthService / SIWE / Nonce / Audit / Repository / 原 T01-T15 断言

CSRF 规则：仅在 POST/PUT/PATCH/DELETE 且存在 access cookie 时校验；Bearer-only 无需 CSRF；logout 使用 Cookie 时必须 CSRF。

---

## P1-003.1 Cookie 配置（env.ts） [P1]

- 修改：`packages/config/src/env.ts`
- 内容：新增字段 `cookieName`、`csrfCookieName`、`cookieDomain`、`cookieSecure`、`cookieSameSite`、`cookiePath`、`csrfHeaderName`
- 默认值：
  - 生产（NODE_ENV=production）：`cookieName=__Host-accesstoken`、`csrfCookieName=__Host-csrf`、`cookieSecure=true`、`cookieSameSite=Lax`、`cookiePath=/`、`cookieDomain` 不设置
  - 开发/测试：`cookieName=access_token`、`csrfCookieName=csrf`、`cookieSecure=false`
- 依赖：无
- 验收：env() 返回所有字段；typecheck/lint 通过
- 风险：env 默认值需兼顾开发(localhost HTTP)与生产(HTTPS)；`__Host-` 前缀需 HTTPS

## P1-003.2 cookie-parser + CookieAuthService [P1]

- 修改：`services/api/src/main.ts`（helmet 之后 `app.use(cookieParser())`）
- 新增：`services/api/src/auth/cookie-auth.service.ts`
  - `setAuthCookie(res, token, expSec)`：set access cookie（HttpOnly=true, Secure/SameSite/Path/Domain 按 env）
  - `clearAuthCookies(res)`：清 access + csrf cookie（Max-Age=0, Path=/, HttpOnly）
- 修改：`services/api/package.json`（+cookie-parser, +@types/cookie-parser）
- 依赖：P1-003.1
- 验收：CookieAuthService 可用；cookie 属性按 NODE_ENV 正确；typecheck/lint 通过
- 风险：`__Host-` 前缀在 localhost HTTP 失效，需环境降级

## P1-003.3 DSC CSRF + GET /api/auth/csrf-token [P0 阻断]

- 新增：`services/api/src/auth/csrf.service.ts`（`crypto.randomBytes(32).toString('base64url')`）
- 新增：`services/api/src/auth/csrf.guard.ts`（DSC: header === cookie 且非空，否则 403）
- 新增：`services/api/src/auth/dto/csrf-token.dto.ts`
- 修改：`services/api/src/auth/auth.controller.ts`（+GET /csrf-token）
- 修改：`services/api/src/auth/auth.module.ts`（注册 CsrfService/CsrfGuard/CookieAuthService）
- 修改：`packages/shared/src/error-codes.ts`（+CSRF_TOKEN_INVALID, +AUTH_CSRF_FAILURE）
- 依赖：P1-003.1, P1-003.2
- 验收：
  - GET /api/auth/csrf-token 返回 {csrfToken} + set csrf cookie
  - POST/PUT/PATCH/DELETE 携带 access cookie 时无/不匹配 X-CSRF-TOKEN → 403 + 审计
  - GET/HEAD/OPTIONS + /nonce + /verify + /csrf-token 豁免
  - Bearer-only 请求（无 access cookie）正常通过
  - CodeQL 无低效正则告警
- 风险：CSRF 豁免清单错误导致误伤或漏防

## P1-003.4 Bearer/Cookie 双模式 Guard（Bearer 优先） [P1]

- 修改：`services/api/src/auth/jwt-auth.guard.ts`（canActivate 双源解析）
- 依赖：P1-003.1, P1-003.2
- 验收：
  - 仅 Bearer → 200；仅 Cookie → 200；Bearer+Cookie → Bearer 优先；双无 → 401
  - AuthContext 结构不变
  - P1-002 原 15 项测试（Bearer 模式）回归全 PASS
- 风险：双源解析顺序错误；cookie 名配置错误

## P1-003.5 verify set-cookie + logout 清 cookie [P1]

- 修改：`services/api/src/auth/auth.controller.ts`
  - postVerify：+@Res({passthrough:true}) + CookieAuthService.setAuthCookie
  - postLogout：+@Res({passthrough:true}) + CookieAuthService.clearAuthCookies
- 依赖：P1-003.2, P1-003.3, P1-003.4
- 验收：
  - verify 成功 set access cookie（属性正确，Max-Age=jwt exp）
  - body 仍含 accessToken（Bearer 兼容）
  - logout 清 access + csrf cookie
  - Redis blocklist/session 不变；jwt-auth.service.ts 不改
- 风险：cookie Max-Age 与 jwt exp 不一致；@Res passthrough 配置错误

## P1-003.6 siwe-client credentials:include + CSRF [P1]

- 修改：`apps/web/src/lib/siwe-client.ts`
  - fetch 改 credentials:'include'
  - 登录前调 GET /api/auth/csrf-token 存 token
  - 状态变更请求附加 X-CSRF-TOKEN header
- 依赖：P1-003.3, P1-003.5
- 验收：前端登录前获取 csrf token；POST 请求附加 X-CSRF-TOKEN；credentials include
- 风险：范围仅限 lib 适配，不做 UI 视觉

## P1-003.7 测试套件（新增 + 回归） [P1]

- 新增：`services/api/test/auth.cookie-csrf.test.ts`
- 保留：`services/api/test/auth.siwe.test.ts`（原 15 项断言不改）
- 依赖：P1-003.1~.6
- 验收：新增测试全 PASS：
  - verify set-cookie 属性断言
  - /csrf-token 返回 + set cookie
  - CSRF 缺失/不匹配 → 403 + 审计；豁免路径通过
  - 仅 Bearer / 仅 Cookie / 双源 Bearer 优先 / 双无 401
  - logout 清 cookie
  - 生产 Secure=true / 测试 Secure=false
  - 并发 /csrf-token 独立 token
  - Bearer-only 无 cookie 时 CSRF 不触发
  - P1-002 原 15 项回归全 PASS，断言不改
- 风险：supertest cookie jar 配置

## P1-003.8 CI 全绿 + PR [P1]

- 依赖：P1-003.1~.7
- 验收：10 项全绿（Install/Lint/Typecheck/Test/Build/Secret/Docker/CI Gate/CodeQL Analyze/Code scanning）
- Merge strategy：Squash and merge
- PR base：develop
- 不自行 Merge
- 风险：CodeQL 对新代码告警（提前规避）；Docker 构建新依赖 cookie-parser
