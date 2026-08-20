# P1-002 Wallet Authentication (SIWE) - Implementation Plan

Baseline: develop HEAD 92a2760de7d09581ea06a14a588c1bc3e49773fd
Branch: feature/p1-002-wallet-auth cut from develop

## Task 1: 切分支 + 依赖 + 配置（env / 错误码）

- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 从 develop HEAD 切出 `feature/p1-002-wallet-auth`。
  - 新增依赖到 `services/api/package.json`：`viem`, `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`, `@types/passport-jwt`, `@nestjs/throttler`（已存在，无需添加）
  - 新增依赖到 `packages/config`：SIWE 相关 env（SIWE_DOMAIN, SIWE_URI, SIWE_NONCE_TTL_SEC, SIWE_STATEMENT）；新增 Chain → chainId 常量映射。
  - `packages/shared/src/error-codes.ts` 追加稳定 auth reason 子代码枚举（不替换 AppErrorCode 主枚举）：`AUTH_BAD_SIGNATURE`, `AUTH_BAD_ADDRESS`, `AUTH_BAD_DOMAIN`, `AUTH_BAD_URI`, `AUTH_BAD_CHAIN_ID`, `AUTH_BAD_NONCE`, `AUTH_NONCE_USED`, `AUTH_EXPIRED`, `AUTH_BAD_ISSUED_AT`, `AUTH_WALLET_REVOKED`, `AUTH_WALLET_DISCONNECTED`, `AUTH_CHAIN_UNSUPPORTED`。
  - `.env.example` 追加 `SIWE_*` 变量注释与默认值。
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-11, AC-16
- **Test Requirements**:
  - `rule` TR-1.1: `pnpm --filter @ai-wealth/config run typecheck` 通过。
  - `rule` TR-1.2: `pnpm --filter @ai-wealth/shared run typecheck` 通过；所有新 reason code 为不重复稳定字符串。
  - `rule` TR-1.3: `env()` 调用不触发 new Missing vars（新加的 SIWE 配置均为 optional + fallback）。
  - `rule` TR-1.4: 安装后 `pnpm --filter @ai-wealth/api run build` 可成功编译新 import（在 Task 2 前先空跑保证依赖安装）。
- **Notes**: 保持现有单阶段 Dockerfile，不做 dev/prod pruning。

## Task 2: 新增 packages/database 追加能力（如需要 migration）+ Chain 工具

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - 评估 Prisma schema：P1-001 已覆盖 models；Wallet.status 初始值。为符合 spec FR-1，决定：Wallet 在 nonce 阶段仅创建当且仅当用户明确要求；更保守方案：nonce 不创建 wallet（只返回 challenge），verify 阶段在事务里“upsert wallet + bind User”。→ 不新增 migration，直接用 findUnique/create。
  - 追加 packages/database/src/index 导出：新增 `ChainUtils.chainToChainId(chain: Chain): number` 与反向映射（供 shared 层使用时不循环依赖，放 database 包合理）。
  - 创建 `packages/database/src/chain-utils.ts` + 单元测试。
  - 不创建新 migration 除非必需；若发现需要字段追加，写 `20260821000000_p1_002_auth_support.sql`。
- **Acceptance Criteria Addressed**: AC-2, AC-3 (chainId 验证基础)
- **Test Requirements**:
  - `rule` TR-2.1: ChainUtils 对 ETH/BSC/POLYGON/ARBITRUM 返回正确 chainId；TRON 返回 -1（unsupported 哨兵）。
  - `rule` TR-2.2: `pnpm --filter @ai-wealth/database run test` 通过（含 chain-utils.test.ts）。
  - `rule` TR-2.3: schema.prisma diff 为空或 migration drift-free（若有 migration 则 `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma` 必须对新模型无 drift 以外的旧模型变化）。

## Task 3: API 领域服务（Nonce / SIWE validator / JWT Auth / Audit / Throttle）

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - 新建 `services/api/src/auth/` 目录：
    - `nonce.service.ts`: `issue(address, chain, network)` 生成 32B nonce（crypto.randomBytes）+ wallet.findUnique or create（status=DISCONNECTED），写 auth_nonce；`validateNonceBeforeConsume(nonceStr)` 查 row + 判断 expiry / used。
    - `siwe.service.ts`: ABNF 正则解析 EIP-4361 message；七字段校验 + `viem.verifyMessage`；返回 `SiweParseResult` + 失败 reason。**不手动加 EIP-191 前缀**（经验：必须避免重复前缀）。
    - `jwt-auth.service.ts`: `sign(userId, walletId?)` 使用 `@nestjs/jwt`；`verify(token)` 返回 payload；redis session write / blocklist write / logout。
    - `audit.service.ts`: fire-and-forget 写入 AuditLog `AUTH_LOGIN_SUCCESS/FAILURE/LOGOUT`；metadata 只含 reasonCode + chain + addressHash（keccak256(address) 前 8 位截断），绝不存 signature/message。
    - `auth.service.ts`: 编排 `nonce.issue`；`verify()` 调用 `siwe.validate` + `Repositories.transaction()`：consume nonce → upsert wallet → get/create user → bind wallet.userId → walletIdentity (SIWE) upsert → user.lastLoginAt touch → commit；成功后 jwt sign + session write；失败路径抛统一 AppError。
    - `jwt-auth.guard.ts`: `@UseGuards(JwtAuthGuard)` 读取 Authorization Bearer，调用 jwtAuthService.verify；检查 Redis blocklist key。
    - `dto/nonce-query.dto.ts`, `dto/verify-request.dto.ts`: class-validator 校验。
    - `auth.controller.ts`: 4 endpoints（`@Get('nonce')`, `@Post('verify')`, `@Post('logout')`, `@Get('me')` + @UseGuards(JwtAuthGuard) on logout/me or only me？spec FR-4: logout 使用 Bearer token 登出当前会话）。
    - `auth.module.ts`: 注册 imports（JwtModule registerAsync，from env）、controllers、providers（含 throttler 自定义 `@Throttle({ default: {limit:20, ttl:60000} })` 对 verify；nonce 使用 per-address 节流（自定义 ThrottlerStorage via RedisService）。
    - rate limit 实现细节：自定义 `AddressThrottlerStorage`（键 `auth:throttle:<ip_or_addr>`；verify/nonce 分别不同 scope）。P1-002 MVP 使用 IP-only 默认 Throttler + 应用层非严格 address per-minute 限制（不阻塞核心）。
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12
- **Test Requirements**:
  - `rule` TR-3.1 (SIWE parser): 合法消息解析出 7 字段；缺 expirationTime 时失败；损坏消息抛具体验证错误。
  - `rule` TR-3.2 (verifyMessage): 使用 viem `privateKeyToAccount(pk).signMessage` 生成签名；经 siwe.service.validate（调用 viem.verifyMessage）通过；篡改签名 1 bit 返回 BAD_SIGNATURE。
  - `rule` TR-3.3 (Nonce 原子): 调用两次 `consume(nonce)` → 首次 ok=true，第二次 ok=false。
  - `rule` TR-3.4 (JWT): sign 后 verify 成功；过期签名（调用 sign 时覆盖 iat 至 -2x exp）verify 失败；blocklist 后 verify 失败。
  - `rule` TR-3.5 (AuthService.transaction 原子): 注入 walletIdentity.create 抛错；事务回滚后 User 数量不变、nonce.usedAt 未被设置（consume 位于事务内时同步回滚）；失败审计行存在。
  - `rule` TR-3.6 (Audit 脱敏): AuditLog.metadata 使用正则不匹配 /0x[a-f0-9]{130,}/ （signature 长度下限）。
  - `rubric` TR-3.7: 分层契合度；scale 0-2，anchors 同 AC-12，threshold >= 2，Evidence: 代码审查 controller/service/repository 边界。

## Task 4: 注册 AuthModule，更新 main.ts / app.module.ts

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3
- **Description**:
  - `app.module.ts` import `AuthModule`；
  - Swagger BearerAuth（已存在 addBearerAuth）；
  - `auth.controller` 使用 `@ApiTags('auth')`；
  - 不改动 CORS / helmet / AllExceptionsFilter（已存在且合规）。
- **Acceptance Criteria Addressed**: AC-1, AC-13, AC-14
- **Test Requirements**:
  - `rule` TR-4.1: `pnpm --filter @ai-wealth/api run test` 的路由存在性断言 GET /nonce /verify POST /logout /me 在 `/api/auth` 前缀下。
  - `rule` TR-4.2: 模拟 origin evil.com 后响应 ACAO != *，断言通过。
  - `rule` TR-4.3: 模拟 Prisma P2002 异常被 catch → 返回 message "Internal Server Error"（非 prod 也统一，参考 spec NFR-2）不含 Prisma / stack。

## Task 5: 15 个认证场景集成测试

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 4
- **Description**:
  - 新建 `services/api/src/auth/__tests__/auth.e2e.spec.ts`（集成）与 `services/api/src/auth/__tests__/siwe.service.spec.ts`, `nonce.service.spec.ts`, `jwt-auth.service.spec.ts`（单元）。
  - E2E 采用 `@nestjs/testing` createNestApplication + Supertest。
  - DATABASE_URL 非本地 → `describe.skip` e2e；但所有场景仍以单元测试（mock Repositories + Redis）覆盖。
  - 用户列出的 15 个测试场景按以下 it 名称映射：
    1. `正常登录：nonce → 正确签名 verify → 200 + token`
    2. `错误签名：tamper signature → 401 (BAD_SIGNATURE)`
    3. `错误地址：recovered address != body.address → 401 (BAD_ADDRESS)`
    4. `错误 domain：domain not in whitelist → 401 (BAD_DOMAIN)`
    5. `错误 URI：uri not in whitelist → 401 (BAD_URI)`
    6. `错误 chainId：chainId 不匹配 → 401 (BAD_CHAIN_ID)`
    7. `过期 SIWE：expirationTime <= now → 401 (EXPIRED)`
    8. `重复 nonce：同 nonce verify 两次 → 第二次 401 (NONCE_USED)`
    9. `已使用 nonce：usedAt 非空 → 401 (NONCE_USED)`
    10. `并发登录：20 并发 同 nonce → exactly 1 success + 19 fail`
    11. `重复钱包登录：同地址两次 → userId 不变`
    12. `禁用钱包登录：REVOKED status → 403 WALLET_REVOKED`
    13. `登出：POST logout → GET /me 失败`
    14. `JWT 无效 / 过期：tampered / expired → 401`
    15. `未登录访问 /me：无 Authorization → 401`
- **Acceptance Criteria Addressed**: AC-15（核心）
- **Test Requirements**:
  - `rule` TR-5.1: `pnpm --filter @ai-wealth/api run test` 结束时 it count total ≥ 15；全部 pass（含 skipped 的非本地 DB e2e 不影响）。
  - `rule` TR-5.2: it（`并发登录`）断言 successes===1 && failures===19。
  - `rule` TR-5.3: it（`禁用钱包登录`）断言 statusCode === 403 且 audit.reasonCode === WALLET_REVOKED。

## Task 6: Web 端基础 SIWE 客户端接入（非 UI 打磨）

- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 4
- **Description**:
  - `apps/web/src/lib/auth.ts` 新增：`fetchNonce(address, chain, network)`；`buildSiweMessage({ nonce, domain, uri, issuedAt, expirationTime, chainId, address })`；`postVerify({ message, signature, address, chain, network })`；`fetchMe(token)`；`postLogout(token)`。
  - 使用 viem `createSiweMessage` 或等价手动拼接（严格 ABNF）。
  - 不修改真实 UI 按钮；Login 页面保持占位但保留调用入口与 React Query 钩子（供未来接入）。
  - 单元测试：buildSiweMessage 输出字段顺序合法；build → parse 两端字段一致。
- **Acceptance Criteria Addressed**: AC-1, AC-3（客户端对齐）, AC-12
- **Test Requirements**:
  - `rule` TR-6.1: `pnpm --filter @ai-wealth/web run typecheck` 通过。
  - `rule` TR-6.2: `apps/web/src/lib/auth.test.ts` buildSiweMessage 能被 `siwe.service.ts`（纯函数）parser 正确解析。
  - `rule` TR-6.3: `pnpm --filter @ai-wealth/web run build`（Next.js build）通过。

## Task 7: lint / typecheck / test / build 本地验证

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1-6
- **Description**:
  - 在 monorepo 根目录依次：`pnpm run format:check`；如失败 → `prettier --write`；再 `pnpm lint`；`pnpm typecheck`；`pnpm test`；`pnpm build`。
  - 特别关注 `wallet-*` 文件是否被 .gitignore 误排除（来自 P1-001 经验：`git check-ignore -v` 检查所有新增 wallet-* 文件，若被忽略则不提交，继续精确匹配修改）。
- **Acceptance Criteria Addressed**: AC-16
- **Test Requirements**:
  - `rule` TR-7.1: `pnpm lint` exit 0。
  - `rule` TR-7.2: `pnpm typecheck` exit 0。
  - `rule` TR-7.3: `pnpm test` exit 0。
  - `rule` TR-7.4: `pnpm build` exit 0（build 顺序 packages 先 → services + apps）。
  - `rule` TR-7.5: `git status -sb` 中任何 wallet-* 源码文件均未显示在 `git check-ignore -v <file>` 输出内。

## Task 8: Docker Build 验证

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 7
- **Description**:
  - 执行 6 个 Docker Build（按 CI pipeline 调用顺序）：
    - `docker build -f infrastructure/docker/Dockerfile.api -t api-test .`
    - `docker build -f infrastructure/docker/Dockerfile.worker -t worker-test .`
    - `docker build -f infrastructure/docker/Dockerfile.blockchain -t blockchain-test .`
    - `docker build -f infrastructure/docker/Dockerfile.web -t web-test .`
    - `docker build -f infrastructure/docker/Dockerfile.admin -t admin-test .`
    - `docker build -f infrastructure/docker/Dockerfile.nginx -t nginx-test .`
  - 任一失败 → 修复 Dockerfile（遵循 P1 经验：单阶段、`npm install -g pnpm`、COPY 路径必须在 build context 内、`apps/web/public/.gitkeep` 必须存在）。
- **Acceptance Criteria Addressed**: AC-16
- **Test Requirements**:
  - `rule` TR-8.1: 6/6 `docker build` 返回 exit 0。
  - `rule` TR-8.2: Dockerfile.api 最终 COPY dist 存在；CMD/START 不引用 pnpm deploy（仍沿用单阶段模型）。

## Task 9: 推送分支 + 创建 PR（feat P1-002 wallet SIWE）

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 8
- **Description**:
  - 推送到 origin `feature/p1-002-wallet-auth`。
  - 通过 GitHub API 创建 PR：feature/p1-002-wallet-auth → develop，标题：`feat: P1-002 wallet authentication with SIWE`，正文引用 `.trae/specs/P1-002-wallet-auth/spec.md` 的 15 场景与 16 AC 清单。
  - 不合并。记录 PR URL 与 PR 号。
- **Acceptance Criteria Addressed**: AC-16
- **Test Requirements**:
  - `rule` TR-9.1: PR state=open，base=develop，head=feature/p1-002-wallet-auth。
  - `rule` TR-9.2: 推送后 `git status -sb` working tree clean（除预先存在未跟踪 docs/release/ 外）。

## Task 10: 等待 CI 全绿 + CodeQL PASS + 输出 Execution Report（不合并）

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 9
- **Description**:
  - 轮询 GitHub API check-runs（PR head sha）直到所有 10 项有 conclusion。失败 → 修复并推送新 commit（再进入 Task 7/8 循环）。
  - 不合并（用户要求 “CI 未全绿禁止合并” 且本 spec 不合并，等待用户验收 merge）。
  - 输出 “完整 Execution Report”，逐项 PASS/FAIL/BLOCKED。
- **Acceptance Criteria Addressed**: AC-16
- **Test Requirements**:
  - `rule` TR-10.1: check-runs（install/lint/type/build/test/secret-scan/docker-build/CI gate/CodeQL analyze/CodeQL）共 10 项全部 success。
  - `rule` TR-10.2: CodeQL 无 critical/high alerts。
