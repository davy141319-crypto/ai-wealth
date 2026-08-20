# P1-002 Wallet Authentication (SIWE / EIP-4361) - Product Requirements Document

## Overview

- **Summary**: 在 develop HEAD `92a2760de7d09581ea06a14a588c1bc3e49773fd` 基线上，实现生产级 Web3 钱包登录功能。使用 SIWE (EIP-4361) 作为签名协议，提供 nonce 挑战、标准 SIWE 消息构建、签名验证、一次性 nonce 标记、User/Wallet/WalletIdentity 原子写入、JWT Session 签发、登出、`/me` 当前用户查询、审计日志、Rate Limit 与并发防重放。
- **Purpose**: 将 P1-001 的身份模型（User/Wallet/WalletIdentity/AuthNonce/AuditLog）落地为真实可运行的钱包认证闭环，保持 API 级安全基线并为后续业务功能提供统一 `@RequireAuth` 鉴权能力。
- **Target Users**: User DApp (Web, Next.js) 的匿名 / 已连接钱包用户；Admin 后续复用同一 JWT 鉴权抽象。

## Goals

- [G-1] 提供 4 个认证接口（nonce/verify/logout/me），统一挂载在 `/api/auth`，Swagger 自动注册。
- [G-2] 完整 SIWE 验证流程（address / domain / URI / chainId / nonce / issuedAt / expirationTime），失败均返回统一错误信封，不泄漏签名细节。
- [G-3] 单次认证跨多表的原子写入（User + Wallet + WalletIdentity + Nonce 标记 + AuditLog + 更新 lastLoginAt），无中途失败留下脏数据。
- [G-4] 并发安全：同一 nonce 在高并发 verify 请求下只允许一次成功，二次尝试验证返回 “已使用 nonce”。
- [G-5] 统一 JWT Session/JWT：`Authorization: Bearer <jwt>`，`/api/auth/me` 返回当前用户与其钱包列表，登出可使会话失效（基于 Redis token blocklist，ttl = jwt 剩余有效期）。
- [G-6] 生产级安全基线：CORS 白名单、Rate Limit（per-IP + per-address）、敏感错误不返回客户端、私钥/助记词永不在服务器出现、JWT secret 仅来自环境变量。
- [G-7] 15 个用户列出的测试场景全部可测，端到端本地测试通过；CI（lint / typecheck / test / build / docker-build / secret-scan / CI Gate / CodeQL）全部 green。

## Non-Goals

- **不开发**：USDT / 充值 / 提现 / 理财 / 收益 / 积分 / 任务 / 邀请 / 团队 / V1-V5 / 博彩 / 体育 / 电竞 / 彩票 / 真人娱乐。
- 不实现钱包私钥托管、账户注册（email/password）、OAuth 社交登录、短信/邮箱验证。
- 不实现 refresh-token rotation（P1+）。
- 不在 DApp 前端实现真实签名按钮交互（P1-002 仅保证后端 API + 前端 wagmi/SIWE 集成基础就绪；重点是后端完整测试）。
- 不修改 P1-001 已验收的数据库枚举 / 字段类型；严格使用追加式 migration。
- 不跳过 CI；不绕过 develop 分支保护。

## Background & Context

- **代码基线（verified）**：
  - develop HEAD `92a2760` 包含 7 个 Prisma 模型（User/Wallet/WalletIdentity/AuthNonce/AuditLog/IdempotencyKey/SystemConfig）、Repository 聚合层 `Repositories.transaction()`、统一 `created_at/updated_at`、CORS 白名单、`/api` 前缀、AllExceptionsFilter、request_id、Request-Level Rate Limit（ThrottlerModule 60s 120次）。
  - API 缺少 auth 模块；`services/api/src/auth/` 尚不存在；未配置 JWT / Passport / Guard；`AuthNonceRepository.consume()` 已实现 updateMany 原子 usedAt 标记（并发安全基础）。
  - Web app 已有 wagmi config + viem 依赖，具备客户端 SIWE 消息生成与签名基础。
- **项目约束（project memory 硬约束）**：
  - P1+ 真实资金业务（USDT/充值/提现等）明确禁止在本阶段。
  - 架构必须遵循 Controller → Service → Repository；复杂领域业务拆分为 Domain Services。
  - 不允许向客户端直接返回数据库错误、堆栈、敏感路径；生产必须 `Internal Server Error` 掩盖。
  - CORS 必须严格使用 `WEB_APP_URL` + `ADMIN_APP_URL`；不允许 `*`。
  - `.env` / 私钥 / seed / wallet secrets 严禁提交 Git。
  - GitHub Actions 必须通过：install / lint / typecheck / test / build / secret-scan / docker-build / CI Gate；main + develop 要求 PR required。

## Functional Requirements

- **FR-1 Nonce 获取（钱包 Connect → 挑战）**：
  - `GET /api/auth/nonce?address=0x...&chain=ETH&network=mainnet`
  - 校验 address checksum / chain ∈ Chain 枚举 / network 非空。
  - 根据 (address, chain, network) 找到或创建 Wallet（只创建钱包行，不创建 User；Wallet 初始状态 DISCONNECTED 以防止未验证的 wallet 被当作已认证身份？→ 决定：Wallet 初始保持 `CONNECTED` 仅当 verify 成功后才真正绑定 User；为区分，初始 Wallet 状态为 `DISCONNECTED`）。
  - 为 Wallet 生成 32 字节加密随机 nonce（base36 / hex 编码），写入 `auth_nonces`，expiresAt = now + SIWE_NONCE_TTL（默认 5 分钟，可配置）。
  - 返回 `{ nonce, issuedAt, expiresAt, domain, uri, statement, chainId }` 以便前端生成标准 SIWE 消息。
- **FR-2 验证签名并签发会话**：
  - `POST /api/auth/verify` body: `{ message, signature, address, chain, network }`
  - `message` 必须是标准 EIP-4361 字符串（A-BNF），`signature` 是 0x 前缀 65 字节 compact（r+s+v）签名。
  - 解析 SIWE message → 提取 `domain/address/uri/chainId/issuedAt/expirationTime/notBefore?/requestId?/nonce`。
  - 验证：
    - address: 与请求 body.address 大小写不敏感相同；checksum 合法；与签名 recover 结果相同。
    - domain: 严格等于 `SIWE_DOMAIN` 或 `WEB_APP_URL` host 部分（白名单）。
    - uri: 严格等于 `SIWE_URI` 或 `WEB_APP_URL`（白名单）。
    - chainId: 等于 `Chain.toChainId(chain)` 映射（ETH=1, BSC=56, TRON=…，TRON 的 SIWE 另行处理；P1-002 scope: 仅 EV 链 ETH/BSC/POLYGON/ARBITRUM。TRON 跳过并返回 400 "chain not supported in P1-002"）。
    - nonce: 存在于 `auth_nonces`，`usedAt IS NULL`，`expiresAt > now`，且所属 wallet 匹配 (address, chain, network)。
    - issuedAt: 合法 ISO 8601，issuedAt ≤ now + 时钟偏移（默认 5 分钟）。
    - expirationTime: 存在且 `expirationTime > now`；缺省拒绝。
  - 签名验证：使用 `viem.verifyMessage({ address, message, signature })` 或等价实现；**不手动拼 EIP-191 前缀**，避免双重前缀。
  - 原子事务：
    - 消耗 nonce（updateMany usedAt = now，并发下只有一条成功）。
    - 查询或创建 User；如果 wallet 已绑定 user 则复用；否则新建 User（status=ACTIVE）并绑定 Wallet.userId，Wallet.status = CONNECTED。
    - 更新或创建 WalletIdentity（identityType = SIWE；唯一 walletId+identityType）。
    - 更新 `users.last_login_at = now`。
    - 写入 AuditLog：action=`AUTH_LOGIN_SUCCESS`，resource=`auth`，actor=userId，metadata 含 chain/address、request_id；**不记录 signature / SIWE 原文**。
  - 签发 JWT：`sub = userId`，`jti` 唯一，`exp` 取 `min(jwtExpiresIn, siwe.expirationTime - now)`；claims 中可携带 `walletId` 可选。
  - 将 jti 写入 Redis `auth:sessions:<jti>` = userId，ttl = jwt.exp；用于 logout 主动失效。
  - 错误路径写入 AuditLog：action=`AUTH_LOGIN_FAILURE`，resource=`auth`，actor=null，metadata 含失败原因编码（如 `BAD_SIGNATURE`, `BAD_DOMAIN`, `NONCE_USED`, `EXPIRED`, `BAD_CHAIN_ID`）、chain、address、request_id；**不记录 signature / SIWE 原文**。
- **FR-3 当前用户**：
  - `GET /api/auth/me`，Header：`Authorization: Bearer <jwt>`。
  - JWT Guard 验证：签名、`jti` 不在 blocklist（Redis `auth:blocked:<jti>`）、存在 session 键。
  - 返回 user + 当前 wallets 列表（不含任何 balance/asset 字段）+ primary wallet。
  - 无 token / 过期 / revoked → 401 UNAUTHORIZED。
- **FR-4 登出**：
  - `POST /api/auth/logout`（可选 Bearer token）。
  - 将 JWT jti 移入 blocklist（Redis `auth:blocked:<jti>` ttl = 剩余 exp）并删除 session 键。
  - AuditLog：action=`AUTH_LOGOUT`。
- **FR-5 速率限制**：
  - `GET /api/auth/nonce`：per-IP 30/min + per-address 10/min（Redis TTL keys）。
  - `POST /api/auth/verify`：per-IP 20/min + per-address 10/min；达到上限 429。
- **FR-6 并发防重放**：
  - 任何两次相同 nonce 的 verify 请求只能有一次成功；即使并行执行，第二次必须看到 nonce.usedAt 已存在并拒绝。
  - 实现依赖：`AuthNonceRepository.consume()`（updateMany where usedAt is null）+ 事务在 consume 之后立即执行后续写入。
- **FR-7 钱包状态机门禁**：
  - 若 Wallet.status = REVOKED / DISCONNECTED（且非新创建），verify 返回 403（记录失败审计）。

## Non-Functional Requirements

- **NFR-1 架构分层**：严格 Controller → Service → Repository/Prisma。认证领域可拆分 `NonceService`、`SiweValidator`、`JwtService`、`AuthService`、`AuditService`（Domain Services）。
- **NFR-2 安全**：
  - 私钥 / 助记词永不进入服务器；服务器只接收并验证签名。
  - 不保存签名原文作为认证凭证；AuditLog.metadata 只保存脱敏摘要（reason code, address hash 等）。
  - Nonce 一次性；任何 usedAt 非空的 nonce 永久拒用。
  - JWT Secret 只能来自环境变量 `JWT_SECRET`；禁止代码硬编码。
  - JWT 不得写入 URL；仅使用 Authorization Header / HttpOnly Cookie（P1-002 scope: Bearer Header only；Cookie 留给 P1-003）。
  - CORS 白名单 WEB_APP_URL + ADMIN_APP_URL；不允许 `*`。
  - 敏感错误统一映射到 `UNAUTHORIZED` / `BAD_REQUEST`；详细原因写入服务端日志与 AuditLog，不返回客户端（在非 prod 环境允许 debug 字段？→ 不允许；生产与非生产使用同一 error envelope）。
- **NFR-3 可观测性**：每个认证事件写入 AuditLog；JWT 签发、失败原因、限流触发分别写入 structured logger（service=api, request_id, action, result, address_hash, chain）。
- **NFR-4 性能**：nonce 接口 p99 < 40ms（本地 Redis + Prisma 单次写）；verify 接口 p99 < 200ms（签名验证 + 1 次事务写）。
- **NFR-5 可测试性**：
  - 单元测试：`SiweValidator`、`JwtService`、`NonceService`、`AuthService`（所有 Repository 都可 mock）。
  - 集成测试：E2E Supertest / Nest Test against 真实 DB（非本地 DB 时自动 skip），覆盖 15 个用户测试场景。
  - 所有测试使用固定 `JWT_SECRET=test-secret-32chars-minimum-safe`；不依赖真实钱包网络。
- **NFR-6 依赖管理**：
  - 使用 `viem`（web 已有）用于签名验证；避免引入 `web3.js` 造成双重依赖。
  - JWT 使用 `@nestjs/jwt` 与 `jsonwebtoken`。
  - Passport / `@nestjs/passport` 可选；可手写 `JwtAuthGuard` + `JwtStrategy`。
- **NFR-7 迁移安全性**：仅允许新增表 / 新增索引 / 新增列，禁止改已有列类型或删除已有枚举值；migration 名 `20260821XXXXXX_p1_002_auth_support`。

## Constraints

- **Technical**:
  - Monorepo：修改集中在 `services/api/`（auth 模块）、`packages/config/`（env：`SIWE_DOMAIN`, `SIWE_URI`, `SIWE_NONCE_TTL_SEC`, `SIWE_STATEMENT`，chainId 映射常量）、`packages/shared/`（新增 `AUTH_*` 错误码，保持稳定枚举值）、`packages/database/`（必要的追加式 Prisma migration）。
  - 严格 /api 前缀；所有 auth 接口路径必须 `/api/auth/*`，并在 Swagger 出现。
  - Dockerfile.api（single-stage pnpm install + build）需保证新增依赖可用；`packages/shared` 若新增导出需同步 `index.ts`。
  - CI Windows 主机：不使用 `&&`，用分号；`gh` 未安装时使用 GitHub API 进行 PR 操作。
- **Business**:
  - 严禁 P1-002 中引入任何真实资金字段 / 业务接口。
  - P1-002 完成后不得自动进入 P1-003；必须等待用户指示。
  - 不合并 PR 除非 CI（含 CodeQL）全绿。
- **Dependencies**:
  - 依赖 P1-001 已验收 RELEASE READY 且 develop HEAD = 92a2760。
  - 依赖 DATABASE_URL 指向 Postgres、REDIS_URL、JWT_SECRET、WEB_APP_URL、ADMIN_APP_URL 已在 CI / 本地 .env 设置。

## Assumptions

- 前端 SIWE 消息由 `viem` / wagmi 构造，签名方式为 `personal_sign`（EIP-191 prefix handled by viem/wallet）；后端 `viem.verifyMessage` 直接使用原 message，不重复拼接前缀。
- TRON 链在 P1-002 暂不支持（SIWE A-BNF 未稳定 / 无 `eth_sign` 语义）；后端在 nonce 时返回 400 "chain TRON not supported in P1-002"，测试覆盖此分支。
- 审计失败日志不得阻塞登录（fire-and-forget）；但若非 DB 级写入失败，服务端日志保留。
- Nonce 未在短时间内清除的历史过期 / 已用数据由未来 worker 清理；不影响 P1-002 功能。

## Acceptance Criteria

### AC-1: 标准 4 接口存在且在 /api/auth 下

- **Type**: `rule`
- **Given**: API 服务启动，Swagger 文档可访问
- **When**: 请求 `GET /api/auth/nonce`、`POST /api/auth/verify`、`POST /api/auth/logout`、`GET /api/auth/me`
- **Then**: 路由存在、均返回统一 ApiResponse envelope、Swagger 显示 4 个 endpoint
- **Pass Condition**: 4 路由在 Nest 路由表中可匹配，Swagger JSON paths 中可见 `/auth/nonce` `/auth/verify` `/auth/logout` `/auth/me`（前缀 /api 由全局 setGlobalPrefix 添加，Swagger 应自动带上）
- **Evidence**: `pnpm --filter @ai-wealth/api run test` 的 e2e/unit 断言 + Swagger 检查

### AC-2: Nonce 接口输入校验 & 下发

- **Type**: `rule`
- **Given**: 无 nonce 缓存
- **When**: 调用 `GET /api/auth/nonce?address=<bad>` 或缺失 chain/network；调用合法请求（checksum 0x address + ETH + mainnet）
- **Then**: 非法入参 422 / 400；合法返回 `{ nonce, issuedAt, expiresAt, domain, uri, chainId }`；nonce 行写入 auth_nonces 且 usedAt 为 null、expiresAt > issuedAt 且 TTL 等于配置（默认 300s）
- **Pass Condition**: 单元测试覆盖 bad address / missing chain / bad chain / unsupported chain (TRON) / success；成功时 DB 存在一行且 (address, chain, network) 对应 wallet 已创建（DISCONNECTED）
- **Evidence**: Jest 测试输出

### AC-3: SIWE 验证 — 地址 / domain / URI / chainId / nonce / issuedAt / expirationTime 七重校验

- **Type**: `rule`
- **Given**: 已获取有效 nonce N；用合法密钥对地址 A 签名一条 SIWE message
- **When**: verify 提交中分别：(a) 修改签名 1 bit；(b) address != recover address；(c) domain != WEB_APP_URL；(d) URI != 白名单；(e) chainId != ETH；(f) nonce != 服务器 nonce；(g) issuedAt 未来偏移 > 5min；(h) expirationTime <= now
- **Then**: 8 个场景分别返回 401 / 400；失败原因编码落在 AuditLog（`BAD_SIGNATURE`, `BAD_ADDRESS`, `BAD_DOMAIN`, `BAD_URI`, `BAD_CHAIN_ID`, `BAD_NONCE`, `BAD_ISSUED_AT`, `EXPIRED`）；不返回 signature / message 原文
- **Pass Condition**: 8 场景每场景至少 1 个 Jest 用例通过；对应 AuditLog 行 metadata.reasonCode 存在
- **Evidence**: Jest 测试 + DB AuditLog 行计数断言

### AC-4: Nonce 成功验证后立即 usedAt 标记

- **Type**: `rule`
- **Given**: 合法 SIWE 签名 + 未用 nonce N
- **When**: verify 成功返回 200 后 立即查询 `auth_nonces.usedAt`
- **Then**: N.usedAt 非空；同 nonce 第二次 verify 返回 401 `NONCE_USED`
- **Pass Condition**: verify success → nonce.usedAt != null；replay → 401 reason=NONCE_USED
- **Evidence**: 集成测试输出

### AC-5: 并发 nonce 防重放

- **Type**: `rule`
- **Given**: 同一个 nonce N；并发发起 20 个相同合法 verify 请求
- **When**: 20 请求并发执行（Promise.all）
- **Then**: 恰好 1 个 200 成功；其余 19 个 401 NONCE_USED 或 409 CONFLICT；User 表只新增 1 行（若为首次登录），AuthLog 恰好 1 条 SUCCESS + 19 条 FAILURE
- **Pass Condition**: Jest 并发测试：`successes === 1` && `failures === 19` && Audit SUCCESS count=1
- **Evidence**: Jest 集成测试（真实 DB）或 SQLite 临时库模拟。需 `DATABASE_URL` 为本地则执行，否则 describe.skip 但仍提供伪并行 mock 单测。

### AC-6: 创建 / 获取 User + Wallet + WalletIdentity 原子事务

- **Type**: `rule`
- **Given**: 首次登录地址 A；verify 过程中 prisma transaction 在 WalletIdentity 写入前抛出故障（测试通过测试夹具注入）
- **When**: 异常抛出
- **Then**: 回滚：无 User、无 Wallet、无 WalletIdentity、nonce 未被 consume；AuditLog 失败行仍存在（审计采用 fire-and-forget 允许在事务外）
- **Pass Condition**: 测试注入 throw 时 User.count === 0、Wallet.count === 0、nonce.usedAt === null
- **Evidence**: Jest 集成测试输出

### AC-7: 重复钱包登录 / 禁用钱包登录门禁

- **Type**: `rule`
- **Given**: User U1 已与 Wallet W1（CONNECTED）绑定；另一测试用例中 Wallet.status = REVOKED
- **When**: 以同地址再次登录；对 REVOKED wallet 登录
- **Then**: 前者 User.id 不变（复用）、WalletIdentity.verifiedAt 更新、lastLoginAt 刷新（成功审计）；后者 403 FORBIDDEN 且失败审计 `WALLET_REVOKED`
- **Pass Condition**: success 分支 user.id 与上次相同；revoked 分支 403 + audit.reasonCode=WALLET_REVOKED
- **Evidence**: Jest 集成测试

### AC-8: 安全 Session/JWT 签发 & Guard

- **Type**: `rule`
- **Given**: verify 成功返回 `accessToken`（JWT）
- **When**: `jwt.io` 手工解析；使用 `JWT_SECRET` 验证；向 `/api/auth/me` 发送 (a) 正常；(b) 篡改；(c) 使用已过期；(d) `jti` 在 blocklist 中（登出后）
- **Then**: JWT `sub` 为 userId；`jti` 唯一；alg = HS256；(a) 200 返回 { user, wallets }；(b)/(c)/(d) → 401 UNAUTHORIZED；AuditLog me 访问可选记录（按需），blocked token 再次使用写失败审计。
- **Pass Condition**: 4 用例 + JWT payload 断言 sub/jti/exp
- **Evidence**: 单元 + 集成测试

### AC-9: 登出接口主动失效会话

- **Type**: `rule`
- **Given**: 合法 JWT，jti=J
- **When**: `POST /api/auth/logout`（Bearer J）后，GET /me 使用同 J
- **Then**: logout 200；/me 401；Redis `auth:blocked:J` 存在并设置 ttl <= jwt 剩余 exp；`auth:sessions:J` 已删除；AuditLog `AUTH_LOGOUT` 行存在
- **Pass Condition**: 401 after logout；Redis key 断言；Audit 行存在
- **Evidence**: 集成测试（RedisService 在测试模式下仍可连接）

### AC-10: 登录成功 / 失败审计日志

- **Type**: `rule`
- **Given**: 正常 verify 成功 1 次 + 失败（BAD_SIGNATURE）1 次
- **When**: 查询 AuditLog 表
- **Then**: 存在 action=`AUTH_LOGIN_SUCCESS` actor=UId 一行；action=`AUTH_LOGIN_FAILURE` actor=null，metadata.reasonCode = `BAD_SIGNATURE` 一行；两行均不含 signature / message 原文
- **Pass Condition**: 两行存在且字段非空；metadata 不包含 0x{130} 签名模式 / `"0x"` 长度 > 100 子串
- **Evidence**: Jest 集成测试断言

### AC-11: Rate Limit 触发

- **Type**: `rule`
- **Given**: 同一 IP 连续 21 次 verify（20/min 额度），同 address 11 次 nonce（10/min 额度）
- **When**: 第 21 次 verify / 11 次 nonce
- **Then**: 返回 429 RATE_LIMITED；Rate-Limit 响应头（可选）；日志记录 rate limit 触发
- **Pass Condition**: 超阈值 429；在 15 test scenarios 中的 “rate limit” 用例通过
- **Evidence**: Supertest / Nest e2e 测试（使用 `@nestjs/throttler` 默认 memory storage 即可；在 CI 单元测试内也能触发）

### AC-12: 架构 Controller → Service → Repository / Domain Service

- **Type**: `rubric`
- **Dimension**: 分层清晰度与跨层依赖方向
- **Scale**: 0-2
- **Anchors**: 0 = Controller 直接调 prisma / 无 service 聚合；1 = 有 Service 但业务逻辑散落在 Controller；2 = Controller 仅路由 + DTO；Service 聚合非数据库逻辑（SIWE validator / JWT / Nonce issuance）；所有 DB 写通过 `Repositories.transaction(...)` 完成
- **Pass Threshold**: >= 2
- **Evidence**: 代码审查路径：`services/api/src/auth/auth.controller.ts` → `auth.service.ts` → `siwe.service.ts` / `jwt-auth.service.ts` / `nonce.service.ts` / `audit.service.ts` → `Repositories.*`

### AC-13: 安全错误不泄漏

- **Type**: `rule`
- **Given**: 生产环境（NODE_ENV=production）任意失败分支（DB 连接失败 / JWT 验证异常 / Prisma 唯一约束冲突）
- **When**: 错误被 AllExceptionsFilter 捕获
- **Then**: 返回 payload.error.message 为 `Unauthorized` / `Bad Request` / `Internal Server Error` 之一；绝不含 SQL、堆栈、行号、表名、`PrismaClientKnownRequestError` 等关键词
- **Pass Condition**: 生产模式下 grep 响应 JSON 不含 `SELECT/INSERT/DELETE/P2002/stack/at file:` 等关键字
- **Evidence**: 单测模拟 Prisma P2002 / 原生 Error 并断言响应体 shape

### AC-14: CORS 严格白名单

- **Type**: `rule`
- **Given**: API 启动时 env().webAppUrl, env().adminAppUrl
- **When**: 请求 Origin = 第三方（http://evil.com）
- **Then**: CORS 响应 `Access-Control-Allow-Origin` 为空或不为 *；预检 OPTIONS 返回 4xx 或 ACAO != *
- **Pass Condition**: e2e test 注入 Origin=http://evil.com → ACAO 头 !== `*` && !== 第三方 origin
- **Evidence**: Supertest 用例

### AC-15: 15 项用户要求测试场景全 PASS

- **Type**: `rule`
- **Given**: 测试环境已配置 JWT_SECRET / DATABASE_URL / REDIS_URL
- **When**: 执行 `pnpm --filter @ai-wealth/api run test`
- **Then**: 15 场景全部 PASS：
  1. 正常登录
  2. 错误签名
  3. 错误地址
  4. 错误 domain
  5. 错误 URI
  6. 错误 chainId
  7. 过期 SIWE
  8. 重复 nonce（两次 verify 同 nonce）
  9. 已使用 nonce（usedAt ≠ null）
  10. 并发登录（Promise.all N 次）
  11. 重复钱包登录
  12. 禁用 / 吊销钱包登录
  13. 登出
  14. JWT 无效 / 过期
  15. 未登录访问受保护 API (/me)
- **Pass Condition**: Jest 测试报告包含 15 个 describe/it 名称并全部 pass；count >= 15
- **Evidence**: Jest stdout

### AC-16: 全链路 CI 质量门禁

- **Type**: `rule`
- **Given**: PR `feat: P1-002 wallet authentication with SIWE`（feature/p1-002-wallet-auth → develop）
- **When**: GitHub Actions 运行完毕
- **Then**: 8 项 CI job + CodeQL 全部 success：Install / Lint / TypeCheck / Build / Unit tests / Secret scan / Docker Build / CI passed gate / CodeQL Analyze / CodeQL
- **Pass Condition**: GitHub commit check-runs conclusion=success 共 10 项；未出现 failed / neutral
- **Evidence**: GitHub API GET check-runs JSON

## Open Questions

- [ ] Web App 前端真实登录 UI 的深度范围？假设为 P1-002 仅做基础接入（wagmi/SIWE 客户端生成函数 + lib auth helper），不做按钮视觉打磨。若用户要求完整 UI，则作为单独任务追加。
- [ ] 是否需要 HttpOnly Cookie 会话？按本 spec 非目标；Bearer 令牌足矣。
- [ ] TRON SIWE 替代方案是否需要设计占位？按假设 P1-002 不支持 TRON 链，返回 400 + 明确 reason。
