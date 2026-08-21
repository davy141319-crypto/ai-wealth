# P1-004 — Refresh Token Rotation + Token Family + Reuse Detection

## 基线

- origin/develop HEAD = `78047536910cc202f5e39e631866804eb469930c`
- 依赖 P1-003 Cookie 双模式 + CSRF、P1-002 JwtAuthService + SIWE
- 分支：`feature/p1-004-refresh-rotation`

## Spec 版本

- v1 (draft): 初稿
- v2: 修复 4 项阻断（重试不返回明文 / lookup 反向索引 / used 墓碑长期保留 / 撤销 Lua 原子）
- v3: 旧 lookup 保留 / 统一 401 INVALID / Cookie 优先 / family 固定 30 天
- v4: CsrfGuard 触发=access OR refresh cookie / logout 支持 access OR refresh / 显式 X-Auth-Transport / 删除 REFRESH_TOKEN_TTL_SEC
- v5 (LOCKED): transport 分端点细化 / logout 始终清 cookie / Origin allowlist 防 transport 降级 + login-CSRF
- v5+ (FINAL, 含 2 项额外强制约束):
  - 约束 A: transport=api 时若存在 access 或 refresh cookie → 在 CSRF 前 403 `TRANSPORT_COOKIE_CONFLICT`（禁止 "api 豁免 CSRF 但携带 cookie" 的歧义）
  - 约束 B: Cookie 模式 logout 两凭证均无效时，LogoutGuard 不得直接抛 401；必须让 Controller 继续执行，先清三 cookie 再返回 401。Guard 只附加凭证校验状态。
- **v5+ FINAL FIX (3 项)**: legacy dual-mode 彻底删除 + 409 仅清 refresh cookie + Lua 脚本 build asset copy 验证
  - **修复 1**: 删除 legacy transport。`/verify`、`/refresh`、`/logout` 缺失或非法 `X-Auth-Transport` 均 400 `TRANSPORT_REQUIRED`。不得同时 set cookie 又 body 返回 token。T01-T15/C01-C11 仅修改测试请求/helper 补正确 transport+Origin，原断言不改。
  - **修复 2**: 409 `REFRESH_RETRY` 仅清 refresh cookie，不得清 access/csrf；新增 `clearRefreshCookie` 方法并加测试，确保现有 access 仍可用。
  - **修复 3**: 验证 `refresh-rotation.lua` 在真实 build 后的 dist 及 API Docker 容器运行路径存在；新增运行时/CI 测试。配置 nest-cli.json `assets` copy。
- **v6 (2 项 P0)**: walletId 正确传递 + SIWE 绝对过期边界保持
  - **P0-1**: 禁止用 `result.user.wallets[0]` 创建 family。`AuthService.verify` additive 返回 `verifiedWalletId`（本次 SIWE 已验证的钱包）；`issueFamily` 必须使用该 walletId 且禁止空值（空值抛 `WALLET_ID_REQUIRED`）。不得改 JwtAuthService/SIWE/Nonce/Repository。
  - **P0-2**: 保持 P1-002 SIWE 绝对过期边界。`AuthService.verify` additive 返回 `authorizationExpiresAt`（`parsed.expirationTime`）；family 保存 `authorizationExpiresAt`。`familyExpiresAt = min(now + familyMaxLifetimeSec, authorizationExpiresAt 若存在)`。每次 refresh 签 access 必须继续传 `absoluteExpiresAtIso`，绝不能越过原 SIWE 授权期限。

## Goals

- [G-1] Rotating Refresh Token：opaque 随机值（`crypto.randomBytes(48).toString('base64url')`，384-bit 熵），使用一次后失效并签发新值。
- [G-2] Token Family：每次 SIWE 登录创建一个 family；rotation 在 family 内继承；reuse 检测以 family 为单位撤销。
- [G-3] Reuse Detection（安全判定规则）：区分"网络重试"与"真实盗用"，避免误撤销合法用户。
- [G-4] 原子 Rotation：Redis Lua 脚本保证并发安全；reuse 撤销在同一 Lua 内原子完成。
- [G-5] Cookie 投递：浏览器模式 refresh token 仅放 HttpOnly Secure `__Host-` cookie，不进 body/localStorage/log。
- [G-6] CSRF：Cookie 模式 refresh/logout 必须 CSRF；Bearer/api 模式（无 cookie）豁免。
- [G-7] logout 撤销整个 family + 清 access/refresh/csrf cookies。
- [G-8] 向后兼容：P1-002 T01-T15、P1-003 C01-C11 断言不改、全 PASS。
- [G-9] 不新增 DB 表/migration；RefreshToken 元数据存 Redis + TTL。
- [G-10] CI 全绿（Lint/Typecheck/Test/Build/Secret/Docker/CI Gate/CodeQL）。

## Non-Goals (OUT-OF-SCOPE)

- ❌ Admin RBAC / TRON SIWE / 完整登录 UI / 任何资金业务（硬约束）
- ❌ 跨设备/跨 family 同步撤销
- ❌ Refresh token 持久化到 DB（V1 仅 Redis；DB 持久化是 P1+）
- ❌ SSO/OAuth 联邦
- ❌ 幂等返回窗口（旧 token 立即 USED；不缓存上次响应）
- ❌ Refresh token 列表 UI / 会话管理面板
- ❌ Worker TTL 清理 job（Redis TTL 自动过期；归档 P1+）
- ❌ `REFRESH_TOKEN_TTL_SEC`（删除；refresh token 寿命 = family 剩余寿命）

## Do Not Touch

- `services/api/src/auth/jwt-auth.service.ts`（仅复用 sign/verify/revoke，不改内部）
- `services/api/src/auth/siwe.service.ts`、`nonce.service.ts`（仅复用）
- `packages/database/src/repositories/*` + 所有 Prisma migration（P1-001 已验收）
- P1-002 T01-T15 断言、P1-003 C01-C11 断言（仅追加新测试，不改原有）
- `services/api/src/auth/audit.service.ts` 既有方法/语义（仅 additive 新增方法，沿用 P1-003 窄豁免模式）

## Architecture

### Refresh Token 格式

- **opaque**：`crypto.randomBytes(48).toString('base64url')`（384-bit 熵，非 JWT）。
- 服务端仅存 **SHA-256 hash**（`refresh:lookup:{tokenHash}` → familyId），不存明文。
- 客户端持有明文；服务端收到后 hash 比对。

### Token Family

- 每次 SIWE verify 成功 → 创建 `familyId = randomUUID()`，签发首个 refresh token。
- family 内 token 形成链：每个 token 记录 `prevTokenHash`（前驱），便于审计链。
- family 生命周期：ACTIVE → ROTATED（链延续）→ REVOKED（logout/reuse/expire）。

### Family 固定寿命

- family 创建时：`familyExpiresAt = min(createdAt + FAMILY_MAX_LIFETIME_SEC, authorizationExpiresAt)`。v6 P0-2: `authorizationExpiresAt` 来自 SIWE `parsed.expirationTime`；若不存在则取配置的 30d（2592000s）。
- **familyExpiresAt 在 family 生命周期内不变**，rotation 不延长。
- 所有 Redis key 的 TTL = `familyExpiresAt - now`（递减，不重置 30 天）。
- refresh token 自身无独立 TTL；其有效性 = Redis key 存在性。
- family 到期后所有 key 自然消失 → 用户重新 SIWE 登录创建新 family。

### Redis Key 结构（全 TTL）

| Key                                   | 值                                                                               | TTL                     | 说明                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `refresh:lookup:{tokenHash}`          | `familyId`                                                                       | `familyExpiresAt - now` | token→family 反向索引；rotation 后**不删除**旧 lookup，保留至 family 到期 |
| `refresh:family:{familyId}`           | `{userId, walletId, status, createdAt, familyExpiresAt, authorizationExpiresAt}` | `familyExpiresAt - now` | family 元数据 + 固定过期时间 + v6 SIWE 授权边界                           |
| `refresh:active:{familyId}`           | `{tokenHash, issuedAt}`                                                          | `familyExpiresAt - now` | family 当前唯一活跃 token                                                 |
| `refresh:used:{familyId}:{tokenHash}` | `{usedAt, retryGraceUntil, retryCount}`                                          | `familyExpiresAt - now` | 已用 token 墓碑；长期保留至 family 过期                                   |
| `refresh:revoked:{familyId}`          | `{revokedAt, reason}`                                                            | `familyExpiresAt - now` | family 撤销标记                                                           |

### Reuse Detection 安全判定规则（三态）

1. **ACTIVE 状态**（token 是当前活跃 token）→ 正常 rotation：标记 USED + 签发新 token + 删旧 active（**不删旧 lookup**）。
2. **USED + 宽限期内**（active 已删，used 墓碑 `retryGraceUntil` 未过）→ **重试**：返回 409 `REFRESH_RETRY`，不返回任何 token 明文，不撤销 family。
3. **USED + 宽限期外 或 retryCount > MAX_RETRY 或 REVOKED** → **真实盗用**：在同一 Lua 内原子撤销整个 family + 审计 `AUTH_REFRESH_REUSE` + 403 `REFRESH_TOKEN_REUSED`。

**MAX_RETRY=2**：容忍 1 次并发 + 1 次重试（共 2 次 used 命中），第 3 次判盗用。可配置。

**重试不返回明文**：Redis 不存明文 → 重试时无法返回新 token。409 方案不泄露任何明文；合法用户重试罕见，access 15min 兜底；重登成本可接受。

### 过期语义（统一 401 INVALID）

- Redis TTL 删除后，lookup/family/used key 自然消失；服务端无法区分"过期"与"伪造"。
- **统一返回 401 `REFRESH_TOKEN_INVALID`**，不返回 `EXPIRED`。
- 客户端收到 401 INVALID → 重新 SIWE 登录（无论实际原因）。
- ~~`AuthFailReason.REFRESH_TOKEN_EXPIRED`~~ 删除。

## Transport 显式模式 + Origin 防降级

### 显式 transport 头

- 请求通过 `X-Auth-Transport: cookie|api` 头声明；缺失 → 400 `TRANSPORT_REQUIRED`。
- **禁止 UA 猜测**；仅依赖 transport 头 + Origin/Referer。

### 浏览器 Origin 检测（防 transport 降级 + login-CSRF）

```
Origin 提取（优先级）：
  1. Origin 头（scheme+host+port）
  2. 无 Origin → Referer 头提取 origin
  3. 无 Origin 且无 Referer → isBrowserOrigin = false

isBrowserOrigin = (提取的 origin ∈ ALLOWED_ORIGINS)
ALLOWED_ORIGINS = { originOf(WEB_APP_URL), originOf(ADMIN_APP_URL) }  // 复用 P0 env
```

### Transport × Origin 校验矩阵

| 请求特征                            | transport=cookie            | transport=api                             |
| ----------------------------------- | --------------------------- | ----------------------------------------- |
| isBrowserOrigin=true（浏览器）      | ✅ 允许                     | ❌ 403 `TRANSPORT_ORIGIN_CONFLICT` + 审计 |
| isBrowserOrigin=false（API 客户端） | ❌ 403 `ORIGIN_NOT_ALLOWED` | ✅ 允许                                   |

### 约束 A：api 模式禁止携带 cookie

- transport=api 时若请求存在 access 或 refresh cookie → **在 CSRF 前 403 `TRANSPORT_COOKIE_CONFLICT`** + 审计。
- 理由：禁止 "api 豁免 CSRF 但携带 cookie" 的歧义（攻击者可能用 api 模式声明绕过 CSRF，但浏览器实际附了 cookie）。
- 该检查在 CsrfGuard 之前执行（TransportMiddleware 顺序先于 CsrfGuard）。

### /verify cookie 模式额外：login-CSRF 防护

- `/verify` 是预登录端点（无认证），易遭 login-CSRF。
- **cookie 模式 /verify 强制 isBrowserOrigin=true**，否则 403 `ORIGIN_NOT_ALLOWED`。
- 防止攻击者页面（Origin 不在 allowlist）发起 cookie 模式 /verify。

### 分端点 transport 规则

| 端点       | cookie 模式                                                                                                          | api 模式                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `/verify`  | 不要求 refresh cookie（预登录）；要求 isBrowserOrigin=true（login-CSRF）；set access+refresh cookie；body 不含 token | body 含 token；不 set cookie          |
| `/refresh` | 必须有 refresh cookie，否则 401 INVALID；要求 isBrowserOrigin=true；CSRF 强制；body 不含 token                       | 从 body 读 refresh；CSRF 豁免         |
| `/logout`  | 允许仅 access 有效（refresh cookie 可有可无）；要求 isBrowserOrigin=true；CSRF 强制；始终清三 cookie                 | 从 Authorization + body 读；CSRF 豁免 |

### Cookie + body 冲突处理

- cookie 模式 + body 也有 refreshToken → Cookie 优先 + CSRF 强制 + body 忽略 + 审计 `AUTH_REFRESH_BODY_IGNORED`。

## CsrfGuard 修订

- 触发条件 = **access 或 refresh cookie 存在**（非仅 access）。
- 豁免：GET/HEAD/OPTIONS + `/auth/nonce` + `/auth/verify`（预会话）。
- `/refresh`、`/logout` 不在豁免列表 → cookie 模式强制 CSRF。
- 执行顺序：TransportMiddleware（含约束 A）→ CsrfGuard。

## logout 统一规则（约束 B）

### LogoutGuard（非 JwtAuthGuard）

- 有效 access JWT **OR** 有效 refresh token → 允许；附加凭证状态到 request。
- 两者都无效 → **不抛 401**；Guard 仍返回 true，附加 `logoutCredentials = { access: null, refresh: null }`，让 Controller 继续执行。

### Cookie 模式 logout 流程（约束 B）

```
1. Transport 校验（cookie 模式 + isBrowserOrigin=true）
2. CsrfGuard 强制（access 或 refresh cookie 存在即触发）
3. LogoutGuard 校验凭证（不抛异常，附加状态）
4. Controller 执行：
   a. 先清三 cookie（access/refresh/csrf）：Max-Age=0 + Expires=epoch
   b. 凭证校验（按附加状态）：
      - 有效 access → blocklist jti
      - 有效 refresh → revokeFamily
      - 有任一有效 → 审计 + 200
      - 两者均无效 → 审计 + 401（cookie 已在 a 步骤清除）
```

**关键**：cookie 模式通过 CSRF 后**始终清三 cookie**，即使凭证已过期。Guard 不抛 401，Controller 先清 cookie 再按凭证状态返回。

### API 模式 logout 流程

```
1. Transport 校验（api 模式 + 无浏览器 Origin + 约束 A：无 cookie）
2. CsrfGuard 豁免
3. 从 Authorization 头读 access，从 body 读 refresh
4. 凭证校验：
   - 有效 access → blocklist jti
   - 有效 refresh → revokeFamily
   - 有任一有效 → 200
   - 两者均无效 → 401（无 cookie 可清）
5. 审计
```

## Rotation 状态机（Lua 原子）

```
-- 输入
--   KEYS[1] = refresh:lookup:{tokenHash}
--   ARGV[1] = tokenHash
--   ARGV[2] = now
--   ARGV[3] = graceSec (30)
--   ARGV[4] = maxRetry (2)
--   ARGV[5] = newTokenHash
--   ARGV[6] = newActiveMeta (json)
-- 返回
--   {0, newActiveMeta}  正常 rotation
--   {1, ''}             重试（409，不返回 token）
--   {2, ''}             盗用（已原子撤销 family，403 REUSED）
--   {3, ''}             family 已撤销 (403 REVOKED)
--   {4, ''}             token 无效（401 INVALID，含过期）

-- 1. 定位 family（lookup 保留，旧 token 仍能找到 family）
local familyId = redis.call('GET', KEYS[1])
if not familyId then return {4, ''} end

local kFamily  = 'refresh:family:'..familyId
local kActive  = 'refresh:active:'..familyId
local kUsed    = 'refresh:used:'..familyId..':'..ARGV[1]
local kRevoked = 'refresh:revoked:'..familyId

-- 2. family 已撤销？
if redis.call('EXISTS', kRevoked) > 0 then return {3, ''} end
local famRaw = redis.call('GET', kFamily)
if not famRaw then return {4, ''} end
local fam = cjson.decode(famRaw)
if fam.status == 'REVOKED' then return {3, ''} end

-- family 剩余寿命（递减，不重置）
local remainingTtl = fam.familyExpiresAt - ARGV[2]
if remainingTtl <= 0 then return {4, ''} end

-- 3. token 是当前活跃 token → 正常 rotation
local active = redis.call('GET', kActive)
if active then
  local am = cjson.decode(active)
  if am.tokenHash == ARGV[1] then
    -- 旧 token used（TTL = family 剩余寿命，长期保留）
    redis.call('SET', kUsed, cjson.encode({
      usedAt=ARGV[2], retryGraceUntil=ARGV[2]+ARGV[3], retryCount=0
    }), 'EX', remainingTtl)
    redis.call('DEL', kActive)
    -- 不删旧 lookup（保留至 family 到期）
    -- 写新 active + 新 lookup（TTL = family 剩余寿命）
    redis.call('SET', kActive, ARGV[6], 'EX', remainingTtl)
    redis.call('SET', 'refresh:lookup:'..ARGV[5], familyId, 'EX', remainingTtl)
    return {0, ARGV[6]}
  end
end

-- 4. token 不是 active → 查 used
local usedRaw = redis.call('GET', kUsed)
if usedRaw then
  local um = cjson.decode(usedRaw)
  if ARGV[2] < um.retryGraceUntil then
    um.retryCount = um.retryCount + 1
    redis.call('SET', kUsed, cjson.encode(um), 'EX', remainingTtl)
    if um.retryCount > ARGV[4] then
      -- 超过 maxRetry：判盗用 → 原子撤销 family
      redis.call('SET', kRevoked, cjson.encode({revokedAt=ARGV[2], reason='REUSE_DETECTED'}), 'EX', remainingTtl)
      fam.status = 'REVOKED'
      redis.call('SET', kFamily, cjson.encode(fam), 'EX', remainingTtl)
      redis.call('DEL', kActive)
      return {2, ''}
    end
    return {1, ''}  -- 重试 409
  else
    -- 宽限期外：盗用 → 原子撤销
    redis.call('SET', kRevoked, cjson.encode({revokedAt=ARGV[2], reason='REUSE_DETECTED'}), 'EX', remainingTtl)
    fam.status = 'REVOKED'
    redis.call('SET', kFamily, cjson.encode(fam), 'EX', remainingTtl)
    redis.call('DEL', kActive)
    return {2, ''}
  end
end

return {4, ''}  -- 统一 INVALID
```

## API 契约

### `POST /api/auth/verify`（扩展 P1-002）

- 头：`X-Auth-Transport: cookie|api`（必须）。
- cookie 模式：isBrowserOrigin=true（login-CSRF）；set access+refresh cookie；**body 仅 `{user}`，不含 accessToken/refreshToken**。
- api 模式：body `{accessToken, refreshToken, user}`；不 set cookie。
- CSRF：豁免（预会话端点）。

### `POST /api/auth/refresh`

- 头：`X-Auth-Transport`（必须）。
- cookie 模式：isBrowserOrigin=true；**必须有 refresh cookie**（否则 401 INVALID）；CSRF 强制；body 不含 token；成功 set 新 cookies + body `{user}`。
- api 模式：无浏览器 Origin；约束 A：无 cookie；从 body 读 refresh；CSRF 豁免；body `{accessToken, refreshToken, user}`。
- 409 RETRY（cookie 模式**仅清 refresh cookie**，access/csrf 不动；access JWT 仍可用）；403 REUSED/REVOKED（清 cookies + 审计）；401 INVALID。

### `POST /api/auth/logout`（修订，约束 B）

- 头：`X-Auth-Transport`（必须）。
- cookie 模式：isBrowserOrigin=true；CSRF 强制；LogoutGuard 不抛 401；Controller 先清三 cookie，再按凭证状态返回（200 或 401）。
- api 模式：无浏览器 Origin；约束 A：无 cookie；从 Authorization + body 读；任一有效 → 撤销 + 200；均无效 → 401。

## Functional Requirements

### FR-1 环境配置

- `packages/config/src/env.ts` 新增：`refreshCookieName`（prod `__Host-refreshtoken`，dev `refresh_token`）、`familyMaxLifetimeSec`（30d=2592000）、`reuseGraceSec`（30）、`maxRefreshRetry`（2）。
- 生产 fail-fast（沿用 P1-003）：`__Host-refreshtoken`、Secure、Path=/、无 Domain、SameSite=lax。
- 复用 `WEB_APP_URL`/`ADMIN_APP_URL` 作 Origin allowlist。
- **删除 `REFRESH_TOKEN_TTL_SEC`**。

### FR-2 RefreshTokenService（新增，不改 JwtAuthService）

- `issueFamily(userId, walletId, authorizationExpiresAt?)` → 创建 familyId + 首个 refresh token，写 Redis（familyExpiresAt = min(now + familyMaxLifetimeSec, authorizationExpiresAt)）。v6 P0-1: walletId 禁止空值；v6 P0-2: authorizationExpiresAt 来自 SIWE expirationTime。
- `rotate(refreshToken)` → 调用 Lua 脚本，返回 `{access, newRefresh} | {retry} | {reuse} | {revoked} | {invalid}`。
- `revokeFamily(familyId, reason)` → 删除 family 所有 keys + 设 revoked 标记。
- `verifyRefreshToken(refreshToken)` → 仅校验（不 rotate），返回 familyId/userId 或无效。
- `hashToken(token)` → SHA-256 hex。
- `generateOpaque()` → 48 bytes base64url。

### FR-3 TransportMiddleware（新增）

- 校验 `X-Auth-Transport` 头；缺失 → 400 `TRANSPORT_REQUIRED`。
- Origin 提取（Origin 优先，Referer fallback）→ isBrowserOrigin。
- Transport × Origin 矩阵校验。
- **约束 A**：transport=api 时若 access 或 refresh cookie 存在 → 403 `TRANSPORT_COOKIE_CONFLICT` + 审计。
- 顺序：TransportMiddleware → CsrfGuard → Guard（JwtAuth/Logout）。

### FR-4 CsrfGuard 修订

- 触发条件 = access OR refresh cookie 存在。

### FR-5 LogoutGuard（新增，约束 B）

- 校验 access OR refresh；不抛异常；附加 `req.logoutCredentials = { access: {valid, jti, userId} | null, refresh: {valid, familyId, userId} | null }`。

### FR-6 POST /auth/refresh endpoint

- transport 分流；Cookie 优先；409/403/401 错误处理；CSRF（cookie 模式）。

### FR-7 SIWE verify 扩展

- verify 成功后额外签发首个 refresh token；transport 响应分流。

### FR-8 logout 扩展（约束 B）

- Controller 先清三 cookie，再按凭证状态返回。

### FR-9 CookieAuthService 扩展

- refresh cookie set/clear（Max-Age=family 剩余寿命）。

### FR-10 审计（additive）

- `AuditAction.AUTH_REFRESH_SUCCESS / FAILURE / REUSE / SESSION_REVOKED / BODY_IGNORED / TRANSPORT_CONFLICT`。
- reuse 事件记 `success=false`。

### FR-11 错误码（shared，additive）

- `AuthFailReason.REFRESH_TOKEN_INVALID / REUSED / REVOKED / RETRY / TRANSPORT_REQUIRED / TRANSPORT_ORIGIN_CONFLICT / TRANSPORT_COOKIE_CONFLICT / ORIGIN_NOT_ALLOWED`。
- ~~`REFRESH_TOKEN_EXPIRED`~~ 删除。

## 故障恢复

- Redis 故障：`/auth/refresh` 返回 503（不降级）；access JWT 仍可用至过期；用户重登录。
- Redis 重启未持久化：所有 family 丢失 → 用户重登录。
- 不引入 DB 兜底（纯 Redis；DB 持久化是 P1+）。

## 测试计划 R01-R28

| #                  | 场景                                                                                                          | 预期                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| R01                | SIWE 登录 cookie 模式 + Origin in allowlist → set cookies，body 不含 token                                    | 200；body 仅 {user}                                    |
| R02                | SIWE 登录 api 模式 + 无浏览器 Origin → body 含 token                                                          | 200；body 有 token；无 Set-Cookie                      |
| R03                | 合法 refresh cookie 模式 → 新 cookies，旧 token USED，旧 lookup 保留                                          | 200；body 无 token                                     |
| R04                | 合法 refresh api 模式 → body 含新 token                                                                       | 200                                                    |
| R05                | 旧 token 宽限期内重试 → 409 RETRY，仅清 refresh cookie（v5+ FINAL）                                           | 409；不返回 token；仅清 refresh                        |
| R06                | 旧 token 宽限期外复用 → 403 REUSED + 原子撤销 + 审计                                                          | 403                                                    |
| R07                | 并发 refresh（同 token）                                                                                      | 一 200 一 409                                          |
| R08                | 第 3 次 used 命中 → 403 撤销                                                                                  | 403                                                    |
| R09                | logout cookie 模式 + 有效 access → 撤销 jti + family + 清三 cookie                                            | 200；三 cookie 清                                      |
| R10                | logout cookie 模式 + access 过期 + 有效 refresh → 撤销 family + 清 cookie + 200                               | 200                                                    |
| R11                | logout cookie 模式 + 两者均无效 → **清 cookie + 401**                                                         | 401；三 cookie 已清                                    |
| R12                | logout api 模式 + 两者均无效 → 401（不清 cookie）                                                             | 401                                                    |
| R13                | cookie 模式 refresh 无 CSRF → 403 CSRF_TOKEN_INVALID                                                          | 403                                                    |
| R14                | api 模式 refresh 无 CSRF → 通过                                                                               | 200                                                    |
| R15                | 伪造 refresh → 401 INVALID                                                                                    | 401                                                    |
| R16                | refresh token 不在 body（cookie 模式）/log                                                                    | 无明文                                                 |
| R17                | family 撤销后任何 token → 403 REVOKED                                                                         | 403                                                    |
| R18                | cookie+body 同时有 refresh → Cookie 优先 + CSRF + body 忽略 + 审计                                            | 200/403                                                |
| R19                | 缺 X-Auth-Transport → 400 TRANSPORT_REQUIRED                                                                  | 400                                                    |
| R20                | api 模式 + 浏览器 Origin in allowlist → 403 TRANSPORT_ORIGIN_CONFLICT + 审计                                  | 403                                                    |
| R21                | cookie 模式 + 无浏览器 Origin → 403 ORIGIN_NOT_ALLOWED                                                        | 403                                                    |
| R22                | /verify cookie 模式 + Origin in allowlist → 通过（login-CSRF 放行）                                           | 200                                                    |
| R23                | /verify cookie 模式 + Origin 不在 allowlist → 403 ORIGIN_NOT_ALLOWED（login-CSRF）                            | 403                                                    |
| R24                | /verify cookie 模式 + 无 Origin/Referer → 403 ORIGIN_NOT_ALLOWED                                              | 403                                                    |
| R25                | api 模式 + 无浏览器 Origin → 通过                                                                             | 200                                                    |
| R26                | family 接近 30 天 → 新 key TTL=familyExpiresAt-now（短）                                                      | TTL < 30d                                              |
| R27                | family 到期后用旧 token → 401 INVALID                                                                         | 401                                                    |
| R28                | /refresh cookie 模式无 refresh cookie → 401 INVALID                                                           | 401                                                    |
| **R29**（约束 A）  | **api 模式 + 携带 access 或 refresh cookie → 403 TRANSPORT_COOKIE_CONFLICT**                                  | 403                                                    |
| **R30**（修复 2）  | **409 RETRY 仅清 refresh cookie；access JWT 仍可认证 /me**                                                    | 409；access/csrf 未清；/me 200                         |
| **R31**（修复 3）  | **refresh-rotation.lua asset-copy 契约（源文件 + nest-cli.json assets glob + 服务读取 basename 一致）**       | 静态检查通过；CI build job + Dockerfile 动态 `test -f` |
| **R32**（v6 P0-1） | **多钱包登录：family walletId = 本次 SIWE 验证的钱包 B，不是 wallets[0]；refresh 后 access JWT walletId = B** | family.walletId = B；JWT.walletId = B                  |
| **R33**（v6 P0-2） | **SIWE exp < 30d：familyExpiresAt 受 SIWE exp 约束；refresh 后 access exp ≤ SIWE exp**                        | familyExpiresAt ≤ SIWE exp；JWT.exp ≤ SIWE exp         |
| **R34**（v6 P0-2） | **无 SIWE exp：family 仍最大 30d（authorizationExpiresAt=null）**                                             | familyExpiresAt ≈ now+30d；authorizationExpiresAt=null |
| 回归               | T01-T15 + C01-C11                                                                                             | 全绿                                                   |

## AC 汇总

| AC                   | 规则                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1                 | SIWE 登录 cookie 模式 → set cookies，body 不含 token                                                                                                           |
| AC-2                 | SIWE 登录 api 模式 → body 含 token，不 set cookie                                                                                                              |
| AC-3                 | 合法 refresh → 新 token；旧 USED；旧 lookup 保留                                                                                                               |
| AC-4                 | 宽限期内重试 → 409 RETRY，不返回 token；cookie 模式**仅清 refresh cookie**（修复 2）                                                                           |
| AC-5                 | 宽限期外复用 → 403 REUSED + 原子撤销 + 审计                                                                                                                    |
| AC-6                 | 并发同 token → 一 200 一 409                                                                                                                                   |
| AC-7                 | 第 3 次 used → 403 撤销                                                                                                                                        |
| AC-8                 | **logout cookie 模式：通过 CSRF 后始终清三 cookie**；有有效凭证 → 撤销 + 200；均无效 → 清 cookie + 401（约束 B：Guard 不抛 401）                               |
| AC-9                 | logout access 过期 + refresh 有效 → 200 + 撤销 family + 清 cookie                                                                                              |
| AC-10                | logout api 模式均无效 → 401（不清 cookie）                                                                                                                     |
| AC-11                | CsrfGuard 触发 = access OR refresh cookie 存在                                                                                                                 |
| AC-12                | cookie 模式 refresh/logout 无 CSRF → 403；api 豁免                                                                                                             |
| AC-13                | refresh token 不进 body（cookie 模式）/log/localStorage                                                                                                        |
| AC-14                | family 撤销后 → 403 REVOKED                                                                                                                                    |
| AC-15                | Redis 不存明文                                                                                                                                                 |
| AC-16                | lookup 旧保留；TTL = family 剩余寿命                                                                                                                           |
| AC-17                | used 墓碑 TTL = family 剩余寿命                                                                                                                                |
| AC-18                | 统一 401 INVALID（不区分 EXPIRED）                                                                                                                             |
| AC-19                | Cookie 优先于 body + body 忽略 + 审计                                                                                                                          |
| AC-20                | 显式 X-Auth-Transport；禁止 UA 猜测；缺失 → 400                                                                                                                |
| AC-21                | 浏览器 Origin + api 模式 → 403 TRANSPORT_ORIGIN_CONFLICT（防降级）                                                                                             |
| AC-22                | cookie 模式 + 无浏览器 Origin → 403 ORIGIN_NOT_ALLOWED                                                                                                         |
| AC-23                | /verify cookie 模式强制 Origin in allowlist（login-CSRF 防护）                                                                                                 |
| AC-24                | /refresh cookie 模式无 refresh cookie → 401 INVALID；/verify 不要求；/logout 允许仅 access                                                                     |
| AC-25                | family 固定 30 天；rotation 不续期；TTL = familyExpiresAt - now                                                                                                |
| AC-26                | 无 REFRESH_TOKEN_TTL_SEC；refresh 寿命 = family 剩余寿命                                                                                                       |
| AC-27                | T01-T15 + C01-C11 回归全绿                                                                                                                                     |
| AC-28                | CI 10/10 + CodeQL 全绿                                                                                                                                         |
| **AC-29**（约束 A）  | **api 模式 + 携带 cookie → 在 CSRF 前 403 TRANSPORT_COOKIE_CONFLICT**                                                                                          |
| **AC-30**（约束 B）  | **LogoutGuard 不抛 401；Controller 先清 cookie 再返回**                                                                                                        |
| **AC-31**（修复 1）  | **legacy dual-mode 删除；/verify//refresh//logout 缺失/非法 transport 均 400；不同时 set cookie 又 body 返回 token**                                           |
| **AC-32**（修复 2）  | **409 RETRY 仅清 refresh cookie；access/csrf 不动；access JWT 仍可用**                                                                                         |
| **AC-33**（修复 3）  | **refresh-rotation.lua 在 dist/ + Docker 镜像运行路径存在（nest-cli.json assets copy；R31 静态契约检查 + CI build job `test -f` + Dockerfile `RUN test -f`）** |
| **AC-34**（v6 P0-1） | **family walletId = AuthService.verify 返回的 verifiedWalletId（本次 SIWE 已验证），禁止 `wallets[0]`；issueFamily 禁止空 walletId**                           |
| **AC-35**（v6 P0-2） | **familyExpiresAt = min(now+30d, SIWE expirationTime)；family 保存 authorizationExpiresAt；refresh 后 access JWT exp ≤ SIWE exp**                              |
| **AC-36**（v6 P0-2） | **无 SIWE expirationTime → family 仍最大 30d（authorizationExpiresAt=null）**                                                                                  |

## 风险

| 风险                        | 等级 | 缓解                                                     |
| --------------------------- | ---- | -------------------------------------------------------- |
| 重试不返回 token → 用户体验 | 中   | access 15min 兜底；opaque 固有 trade-off                 |
| Redis Lua 脚本错误          | 高   | 脚本单测；evalsha 回退 eval；FakeRedisService eval mock  |
| Redis 故障                  | 中   | 503 不降级；access 仍可用                                |
| MAX_RETRY 阈值              | 中   | 默认 2；可配置；测试覆盖边界                             |
| refresh token 泄露          | 中   | opaque + hash + HttpOnly `__Host-` cookie                |
| Origin/Referer 剥离         | 中   | Origin 优先 + Referer fallback；cookie 模式无两者 → 403  |
| CsrfGuard 改动影响 P1-003   | 中   | C01-C11 回归验证                                         |
| login-CSRF 绕过             | 中   | /verify cookie 模式强制 Origin allowlist                 |
| transport 降级攻击          | 中   | Origin × transport 矩阵 + 约束 A（api+cookie→403）+ 审计 |
| FakeRedisService 需支持 Lua | 中   | mock eval 返回预置 code；或真实 Redis 集成测试 gate      |

## SPEC STATUS: LOCKED / READY FOR IMPLEMENTATION
