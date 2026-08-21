# P1-005 — Web Frontend Auth Integration Tasks（v3）

## T01 — authApi 独立 axios 实例（无 401 拦截器）

- 新建 apps/web/src/lib/authApi.ts
- 独立 axios.create({ withCredentials: true, baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api' })
- 不装 401 response interceptor（关键：避免循环依赖）
- 仅供 /auth/nonce / /auth/me / /auth/verify / /auth/refresh / /auth/logout
- 导出 authApi 实例

## T02 — AuthSessionCoordinator（单例，框架无关）

- 新建 apps/web/src/auth/AuthSessionCoordinator.ts
- 不依赖 React（纯 TS class / 模块单例）
- 依赖：仅使用 authApi + SiweWalletClient（禁止使用 api.ts）
- 职责：
  - restore()：应用启动调 /auth/me 恢复会话（全程 initializing）
  - handleUnauthorized(originalRequest)：运行时 401 → single-flight refresh + 重试
  - handleUnauthorizedRestore()：初始化期 401 → single-flight refresh（不广播 refreshing）
  - handleForbidden()：403 REUSED/REVOKED → 通知失效
  - notify(state)：向订阅者广播状态变化
  - subscribe(listener)：AuthProvider 订阅
- 内部状态：sessionState ∈ initializing|authenticated|unauthenticated
- single-flight：inflightRefresh Promise，并发 await 同一 Promise
- 409 处理：调 /auth/me 判定（不循环 refresh）

## T03 — axios 401/403 拦截器（仅普通 api.ts，仅调 Coordinator）

- 修改 apps/web/src/lib/api.ts
- 装 response 拦截器：
  - 401（非 /auth/* 请求）→ Coordinator.handleUnauthorized(原请求配置)
  - 403 REUSED/REVOKED → Coordinator.handleForbidden()
- 禁止：拦截器直接调 useAuth / AuthProvider / React setState
- 禁止：拦截器内部实现 refresh 逻辑（全部委托 Coordinator）
- 禁止：api.ts 供 Coordinator/SiweWalletClient 使用

## T04 — AuthProvider + useAuth hook

- 新建 apps/web/src/auth/AuthProvider.tsx（React Context）
- mount 时调 Coordinator.restore()
- subscribe(Coordinator) → 同步 React state
- 暴露 { user, status, login, logout }
- login()：调 SiweWalletClient.login()（via authApi），成功后 Coordinator.notify
- logout()：调 SiweWalletClient.logout()（via authApi），Coordinator.notify
- status 派生：initializing | authenticating | authenticated | refreshing | unauthenticated

## T05 — 应用启动恢复（initializing 全程不广播 refreshing）

- Coordinator.restore()：
  1. notify({ status:'initializing' })
  2. GET /auth/me [authApi]
     - 200 → notify({ status:'authenticated', user })
     - 401 → handleUnauthorizedRestore()：
       - 全程保持 initializing（不广播 refreshing）
       - single-flight refresh [authApi]：
         - 200 → authenticated
         - 409 → /auth/me [authApi] 判定（见 T07）
         - 401/403 → unauthenticated
     - 403/其他 → unauthenticated
- ProtectedRoute：initializing 期间渲染 loading，不 redirect，不渲染 children

## T06 — 运行时 401 触发 single-flight refresh + 重试（已 authenticated）

- Coordinator.handleUnauthorized(原请求)：
  - 广播 refreshing
  - single-flight refresh [authApi]：
    - 200 → authenticated + 重试原请求 [api.ts]
    - 409 → /auth/me 判定（见 T07）
    - 401/403 → unauthenticated → /login
- 并发 401：所有 handleUnauthorized await 同一 Promise

## T07 — 409 RETRY → /auth/me 判定（不循环 refresh）

- Coordinator 内：
  - refresh 返回 409 → 不再 refresh
  - 立即调 GET /auth/me [authApi]：
    - 200 → authenticated + user + 重试原请求（最多1次）
    - 401 → unauthenticated → redirect /login
    - 403 → unauthenticated → redirect /login
- 禁止：409 后直接保持 authenticated 而不验证
- 禁止：refresh 循环

## T08 — 403 REUSED/REVOKED 处理

- Coordinator.handleForbidden()：
  - 调 SiweWalletClient.clearSession()
  - notify({ status:'unauthenticated' })
  - 触发 redirect /login

## T09 — ProtectedRoute 客户端守卫

- 新建 apps/web/src/components/ProtectedRoute.tsx
- 读取 useAuth().status
- status='initializing' → 渲染 loading（不 redirect，不渲染 children）
- status='authenticating' → 渲染 loading（不 redirect）
- status='authenticated' → 渲染 children
- status='refreshing' → 渲染 children（保持当前视图）
- status='unauthenticated' → redirect /login?next=<original>

## T10 — Next.js middleware presence prefilter（v3 修订）

- 新建 apps/web/src/middleware.ts
- 匹配 /dashboard/*
- 检查请求 cookie：
  - access cookie 存在 OR refresh cookie 存在 → 放行
  - 两者都不存在 → redirect /login?next=<original>
- ⚠️ 仅 presence prefilter，不验签，不视为认证
- 真实认证由 AuthProvider /auth/me 完成
- cookie 名称根据 NODE_ENV 匹配 dev/prod 命名契约：
  - dev: access_token / refresh_token
  - prod: __Host-accesstoken / __Host-refreshtoken
- matcher 排除 /login / / /_next / /api

## T11 — Dashboard 页面接入

- 修改 apps/web/src/app/dashboard/page.tsx
- 包裹 ProtectedRoute
- 显示当前 user（地址、钱包列表）
- 添加 logout 按钮

## T12 — Login 页面接入真实 SIWE

- 修改 apps/web/src/app/login/page.tsx
- 使用 wagmi useAccount / useSignMessage
- 调 useAuth().login()
- 成功 → redirect /dashboard（或 ?next=）
- 失败 → 显示错误

## T13 — Providers 注入 AuthProvider

- 修改 apps/web/src/components/Providers.tsx
- WagmiProvider > QueryClientProvider > AuthProvider > children

## T14 — 禁止 token 进 localStorage/sessionStorage

- 代码 review：session.token 仅内存态（cookie 模式下 undefined）
- AuthProvider user 仅内存态
- 不新增 localStorage.setItem / sessionStorage.setItem('token'...)

## T15 — Coordinator 单元测试

- restore()：/auth/me 200 → authenticated（全程 initializing → authenticated）
- restore()：/auth/me 401 → refresh 200 → authenticated（全程 initializing，不广播 refreshing）
- restore()：/auth/me 401 → refresh 409 → /auth/me 200 → authenticated
- restore()：/auth/me 401 → refresh 409 → /auth/me 401 → unauthenticated
- restore()：/auth/me 401 → refresh 401 → unauthenticated
- restore()：/auth/me 401 → refresh 403 REUSED → unauthenticated
- restore() 全程状态保持 initializing（验证不广播 refreshing）
- handleUnauthorized()：single-flight（并发 401 只 refresh 一次）
- handleUnauthorized()：refresh 200 → 广播 refreshing → authenticated
- handleUnauthorized()：refresh 409 → /auth/me 200 → 重试原请求成功
- handleUnauthorized()：refresh 409 → /auth/me 401 → unauthenticated
- handleForbidden()：403 → unauthenticated
- 禁止循环 refresh（409 后不再 refresh）
- 禁止 Coordinator 使用 api.ts（仅 authApi）

## T16 — axios 拦截器集成测试

- mock axios + Coordinator
- api.ts 401 → 调 Coordinator.handleUnauthorized
- api.ts 403 REUSED → 调 Coordinator.handleForbidden
- 拦截器不直接调 useAuth
- /auth/* 请求（via authApi）401 不触发拦截器递归
- authApi 无 401 拦截器（验证不装）

---

## 验收修复任务（v3.1，基线 ab7faf9）

### TF1 — 修复首次 wallet connect 竞态

- [x] 禁止 `connectAsync` 后 `setTimeout` 读 `useAccount` ref
- [x] 未连接时：`const result = await connectAsync(...)`，从 `result.accounts[0]` + `result.chainId` 构造返回值
- [x] `accounts` 为空 → 明确报错
- [x] 已连接时才用当前 `address + chainId`；`chainId` undefined → 报错（不回退 1）
- [x] 测试 WC01-WC08（8 tests）：初始未连接返回 B+11155111；不误用 mainnet chainId=1；空 accounts 报错；已连接用当前值；chainId undefined 报错

### TF2 — 真正实现 refreshing 状态

- [x] `SessionState` 新增 `refreshing` 变体（保留 user）
- [x] `handleUnauthorized` 已 authenticated 时广播 `refreshing` → refresh 成功 `authenticated` / 失败 `unauthenticated`
- [x] `restore` / `handleUnauthorizedRestore` 全程 `initializing`，绝不广播 `refreshing`（AC-21）
- [x] ProtectedRoute：refreshing → 渲染 children
- [x] 测试 U08-U11（Coordinator 单元）：refresh 进行中 refreshing 保留 user；失败 unauthenticated；restore 不出现 refreshing；并发 single-flight refreshing 只广播一次
- [x] 测试 RT06-RT07（真实 React 渲染）：401→refreshing 期间 SECRET 可见→成功 authenticated；restore refresh 只有 initializing→authenticated

### 测试数汇总

- apps/web：97 tests（原 83 + 14 新增）
- CI：10/10 全绿

## T17 — AuthProvider 状态机测试

- mount → initializing → authenticated（/auth/me 200）
- mount → initializing → unauthenticated（/auth/me 401 → refresh fail）
- mount → initializing 全程不广播 refreshing（即使内部执行 refresh）
- login() → authenticating → authenticated
- login() 失败 → authenticating → unauthenticated
- logout() → unauthenticated
- ProtectedRoute：initializing → loading（不 redirect，不渲染 children）
- ProtectedRoute：refreshing → 渲染 children

## T18 — E2E 测试

- 登录成功 → /dashboard 可访问
- 页面刷新 → initializing → authenticated（不闪现 /login，不渲染 children）
- access 过期 → 401 → refresh → 重试成功
- refresh 409 → /auth/me 判定 → authenticated
- refresh 409 → /auth/me 401 → /login
- logout → /dashboard 重定向 /login
- 未登录访问 /dashboard → middleware redirect /login
- middleware：仅 access cookie → 放行；仅 refresh cookie → 放行；两者无 → redirect
- token 不在 localStorage/sessionStorage

## 强制约束验证任务

### A. authApi baseURL 同源

- 验证 authApi baseURL === api.ts baseURL
- 验证使用 `process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api'`
- 单元测试断言同源

### B. SiweWalletClient 仅用 authApi

- 验证 siwe-client.ts 默认依赖从 api 改为 authApi
- 验证无 fallback 到 api.ts
- 单元测试断言

### C. middleware cookie 命名契约

- 验证 dev 环境 cookie 名称：access_token / refresh_token
- 验证 prod 环境 cookie 名称：__Host-accesstoken / __Host-refreshtoken
- 单元测试覆盖 dev/prod 两种环境
