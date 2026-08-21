# P1-005 — Web Frontend Auth Integration

## Baseline

origin/develop@85db6008e1f4d00fd9cf77b8e45f5a10ecc9a4dd

## Goal

把 P1-002（SIWE 登录）~ P1-004（refresh rotation）的后端认证完整接入 apps/web，使用户
可以通过钱包签名登录、会话由 HttpOnly cookie 承载、页面刷新保持登录态、access 过期自动
refresh、异常会话回登录页。前端不得把 access/refresh token 放入 localStorage / sessionStorage。

## IN Scope

1. Cookie 模式 SIWE 登录（复用 siwe-client.ts，接入真实 wagmi connector）
2. AuthProvider / session state（React Context，内存态 + cookie 承载）
3. /auth/me 恢复登录态（应用启动时静默校验）
4. 401 触发一次 refresh 并重试原请求（axios 拦截器经 Coordinator）
5. 409 REFRESH_RETRY 不得循环 refresh；改为调用一次 /auth/me 判定会话存活
6. 403 REUSED / REVOKED 清客户端状态并回登录页
7. 受保护 Dashboard 路由（客户端守卫 + 服务端 middleware presence prefilter）
8. logout（清 cookie + 清客户端状态 + 回首页）
9. 页面刷新保持会话（cookie HttpOnly + /auth/me 静默校验）
10. refresh/access 不得进 localStorage / sessionStorage（仅 HttpOnly cookie + 内存）

## OUT Scope（不变）

- apps/admin 集成（留给后续阶段）
- 设备管理 / 会话列表（G3，留给后续阶段）
- DB migration（无新表）
- 后端认证逻辑重构（不改 services/api/src/auth 任何业务逻辑）
- 资金类业务（USDT / 充提 / 理财等，testnet 阶段才开启）

## Dependencies

- 后端：services/api@develop@85db6008（P1-002~004 已合并，不动）
- 前端基线：apps/web 现有 siwe-client.ts、api.ts、Providers.tsx

## Non-Goals

- 不新增后端端点
- 不改 JwtAuthService / SIWE / Nonce / RefreshTokenService
- 不改 Prisma schema
- 不做 SSG/SSR token 注入（cookie 由浏览器自动携带）

## Security Constraints

- access/refresh token 永远不进 localStorage / sessionStorage / URL
- refresh token 永远不被 JS 读取（HttpOnly cookie）
- 所有状态变更请求带 X-CSRF-TOKEN（DSC，复用 siwe-client.ts）
- 所有 /verify / /refresh / /logout 带 X-Auth-Transport: cookie
- 页面刷新后不得闪现未授权内容（守卫先阻塞渲染）

## Architecture（v3：双 axios 实例，消除循环依赖）

### 双 axios 实例

- authApi（apps/web/src/lib/authApi.ts）
  - 独立 axios 实例，withCredentials=true
  - baseURL 与 api.ts 同源：`process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api'`
  - 无 401 response interceptor（关键：避免循环依赖）
  - 仅供 nonce / me / verify / refresh / logout
  - 由 Coordinator / SiweWalletClient 专用
- api（apps/web/src/lib/api.ts，普通业务请求）
  - 独立 axios 实例，withCredentials=true
  - 装 401 response interceptor → Coordinator
  - 仅供业务请求（/api/xxx）

### 分层

- React 层（AuthProvider / useAuth / ProtectedRoute）：订阅 Coordinator
- AuthSessionCoordinator（单例，框架无关）：不依赖 React
  - single-flight refresh
  - session 失效通知
  - /auth/me 恢复
- SiweWalletClient + authApi（无 401 拦截器）：HTTP 层

### 关键原则（v3）

1. authApi 是独立 axios 实例，无 401 拦截器；Coordinator/SiweWalletClient 只用 authApi
2. 普通业务 api.ts 装 401 拦截器 → 调 Coordinator（不直接调 useAuth）
3. 消除循环依赖：api.ts → Coordinator → SiweWalletClient → authApi（无 401 拦截器）→ 后端
4. Coordinator 是单例，框架无关
5. AuthProvider 订阅 Coordinator 的状态变化
6. single-flight：Coordinator 保证同一时刻最多一个 refresh 在途

## State Machine（v3：initializing 全程不广播 refreshing）

状态枚举（5 态）：

- 'initializing' // 应用启动，正在执行 /auth/me 恢复（含恢复期 refresh）
- 'authenticating' // SIWE 登录进行中
- 'authenticated' // 已登录，user 已加载
- 'refreshing' // 已 authenticated 后运行时请求 401 触发的单次 refresh
- 'unauthenticated' // 未登录或会话失效

状态转换规则（v3 修订）：

1. 应用启动 → initializing（唯一入口）
2. initializing → authenticated：/auth/me 200，或 /auth/me 401 → refresh 200
3. initializing → authenticated：/auth/me 401 → refresh 409 → /auth/me 200
4. initializing → unauthenticated：/auth/me 401 → refresh 401/403，或 refresh 409 → /auth/me 401/403
5. initializing → unauthenticated：/auth/me 403/其他异常
6. ⚠️ initializing 期间执行的 refresh 不广播 refreshing（状态始终 initializing）
7. unauthenticated → authenticating：用户发起 SIWE login
8. authenticating → authenticated：/auth/verify 200
9. authenticating → unauthenticated：/auth/verify 失败
10. authenticated → refreshing：运行时请求 401，Coordinator 触发 single-flight refresh
11. refreshing → authenticated：refresh 200，或 refresh 409 → /auth/me 200 → 原请求重试成功
12. refreshing → unauthenticated：refresh 401/403，或 refresh 409 → /auth/me 401/403
13. authenticated → unauthenticated：用户 logout / 收到 403 REUSED|REVOKED

ProtectedRoute 行为（v3 修订）：

- status='initializing' → 渲染 loading（不 redirect，不渲染 children）
- status='authenticating' → 渲染 loading（不 redirect）
- status='authenticated' → 渲染 children
- status='refreshing' → 渲染 children（保持当前视图，后台刷新）
- status='unauthenticated' → redirect /login

⚠️ 初始化全过程（即使内部执行了 refresh）：始终 initializing → loading
绝不渲染 children，绝不 redirect（直到恢复完成才转 authenticated/unauthenticated）

## API Call Flow

### 1. 首次 SIWE 登录（cookie 模式，使用 authApi）

- GET /auth/nonce → 200 { nonce, ... }
- GET /auth/csrf-token → 200 { csrfToken }
- wallet.signMessage(siweMessage)
- POST /auth/verify [X-Auth-Transport: cookie, X-CSRF-TOKEN] → 200 { user } + Set-Cookie
- Coordinator.notify({ status:'authenticated', user })

### 2. 应用启动恢复会话（initializing 全程不广播 refreshing）

- AuthProvider mount → status='initializing'
- Coordinator.restore()：
  - GET /auth/me [authApi，无 401 拦截器]
    - 200 { user } → notify({ status:'authenticated', user })
    - 401 → handleUnauthorizedRestore()：（初始化分支，不广播 refreshing）
      - single-flight refresh [authApi]：
        - 200 → authenticated
        - 409 → 调 GET /auth/me [authApi]：200 → authenticated；401/403 → unauthenticated → /login
        - 401 INVALID → unauthenticated → /login
        - 403 REUSED/REVOKED → unauthenticated → /login
      - ⚠️ 全程状态保持 initializing（不广播 refreshing）
    - 403/其他 → notify({ status:'unauthenticated' })
- ProtectedRoute：initializing 期间渲染 loading，不 redirect，不渲染 children

### 3. 运行时 401 触发 single-flight refresh + 重试（已 authenticated，经 Coordinator）

- GET /api/xxx [via api.ts，有 401 拦截器] → 401
- axios 拦截器调 Coordinator.handleUnauthorized(原请求)
  - Coordinator 检查：是否已有 refresh 在途？
    - 是 → await 同一 Promise（single-flight）
    - 否 → 广播 refreshing → 启动 refresh [authApi]：
      - 200 { user } → notify authenticated + 重试原请求 [api.ts]
      - 409 → 不再 refresh；调 GET /auth/me [authApi]：
        - 200 → authenticated + 重试原请求（最多1次）
        - 401/403 → unauthenticated → /login
      - 401 INVALID → unauthenticated → redirect /login
      - 403 REUSED/REVOKED → unauthenticated → /login
- 并发 401：所有 handleUnauthorized await 同一个 refresh Promise

### 4. logout（使用 authApi）

- POST /auth/logout [X-Auth-Transport: cookie, X-CSRF-TOKEN] → 200 { loggedOut } + Set-Cookie 清除
- Coordinator.notify({ status:'unauthenticated' }) → redirect /

### 5. middleware presence prefilter（v3 修订）

- Next.js middleware（服务端）匹配 /dashboard/*
- 检查请求 cookie：
  - access cookie 存在 OR refresh cookie 存在 → 放行（允许进入页面壳，AuthProvider /me 做真实认证）
  - 两者都不存在 → redirect /login?next=<original>
- ⚠️ middleware 仅做 presence prefilter，不验签，不视为认证
- 真实认证由 AuthProvider /auth/me 完成
- cookie 名称根据 NODE_ENV 匹配 dev/prod 命名契约

## Acceptance Criteria

| AC #  | 验收项                                                                                                           | 验证方式             |
| ----- | ---------------------------------------------------------------------------------------------------------------- | -------------------- |
| AC-1  | 用户可通过钱包签名完成 SIWE 登录，成功后跳转 /dashboard                                                          | E2E                  |
| AC-2  | 登录后 /auth/me 返回 user，Coordinator 通知 authenticated                                                        | 单元                 |
| AC-3  | 页面刷新后保持登录态（initializing 期间渲染 loading，不闪现 /login，不渲染 children）                            | E2E                  |
| AC-4  | access 过期后任意请求 401 → Coordinator single-flight refresh → 重试成功                                         | 集成                 |
| AC-5  | refresh 返回 409 → 不循环 refresh；调 /auth/me：200 则 authenticated + 重试，401/403 则 unauthenticated → /login | 集成                 |
| AC-6  | refresh 返回 403 REUSED/REVOKED → 清状态，redirect /login                                                        | 集成                 |
| AC-7  | 未登录访问 /dashboard → middleware redirect /login                                                               | E2E                  |
| AC-8  | logout 后 cookie 清除，/dashboard 重定向 /login                                                                  | E2E                  |
| AC-9  | access/refresh token 不出现在 localStorage / sessionStorage                                                      | 代码 review + 运行时 |
| AC-10 | 所有 /verify / /refresh / /logout 带 X-Auth-Transport: cookie                                                    | 集成                 |
| AC-11 | 所有状态变更请求带 X-CSRF-TOKEN                                                                                  | 集成                 |
| AC-12 | 并发 401 仅触发一次 refresh（single-flight）                                                                     | 集成                 |
| AC-13 | axios 拦截器不直接调 useAuth / AuthProvider（仅调 Coordinator）                                                  | 代码 review          |
| AC-14 | Coordinator 不依赖 React（纯 TS，可独立测试）                                                                    | 单元                 |
| AC-15 | 应用启动 status='initializing'，恢复完成前 ProtectedRoute 渲染 loading 不 redirect 不渲染 children               | 集成 + E2E           |
| AC-16 | 后端认证代码零改动（services/api/src/auth 无 diff）                                                              | git diff             |
| AC-17 | 无 DB migration（schema.prisma 无 diff）                                                                         | git diff             |
| AC-18 | lint / typecheck / test / build 全绿                                                                             | CI                   |
| AC-19 | authApi 独立 axios 实例，无 401 拦截器，baseURL 与 api.ts 同源                                                   | 代码 review + 单元   |
| AC-20 | Coordinator/SiweWalletClient 仅使用 authApi（不使用 api.ts）                                                     | 代码 review          |
| AC-21 | 初始化期 restore 即使执行 refresh，状态始终 initializing（不广播 refreshing）                                    | 单元                 |
| AC-22 | refreshing 仅用于已 authenticated 后运行时 401（非初始化）                                                       | 单元                 |
| AC-23 | middleware presence prefilter：access 或 refresh 任一存在 → 放行；两者无 → redirect                              | E2E                  |
| AC-24 | middleware 仅 prefilter，真实认证由 /auth/me 完成                                                                | 代码 review + E2E    |

## 强制约束（实施时必须遵守）

### A. authApi baseURL 同源配置

- authApi baseURL 必须与现有 api.ts 同源：`process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api'`
- 禁止未经验证改成固定 `/api`

### B. SiweWalletClient 仅使用 authApi

- SiweWalletClient 必须改为仅使用 authApi（默认依赖或显式注入）
- 禁止任何路径 fallback 到业务 api.ts

### C. middleware cookie 名称契约

- middleware access/refresh cookie 名称必须与后端实际 Cookie 配置一致
- dev: `access_token` / `refresh_token`
- prod: `__Host-accesstoken` / `__Host-refreshtoken`
- 必须测试 dev/prod 命名契约
