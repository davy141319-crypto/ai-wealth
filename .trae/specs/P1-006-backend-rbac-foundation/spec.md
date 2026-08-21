# P1-006 — Backend RBAC Foundation

> **Status: SPEC LOCKED / READY FOR IMPLEMENTATION.**
> Baseline: `origin/develop@8343b3ad473e11396f1a1f57f4418718ca459cea`
> This document is the **single implementation contract** (v2.1 full text +
> v2.2 final patches + implementation-time hardening A/B). No other source of
> truth supersedes it.

## Goal

在不破坏 P1-002~005 现有认证/session 体系的前提下，建立最小、可审计、
default-deny 的后端 RBAC 地基，供 P1-007 Admin Auth Integration 直接消费。
JWT 继续只负责 Authentication；Authorization 实时读 DB 当前 role+status，
每请求仅一次 DB 查询。

## IN Scope

1. enum `UserRole { USER, ADMIN }`
2. `User.role UserRole @default(USER)` + Prisma migration（存量回填 USER）
3. `UserRepository.getAuthorizationContext(id)` → `{ role, status } | null`
   （单次 DB 查询同时取 role 与 status；禁止两次查询）
4. `@Roles(...roles)` 装饰器（SetMetadata）
5. `RolesGuard`：
   - 依赖 `JwtAuthGuard` 产出的 `req.auth.userId`
   - 每请求一次 `getAuthorizationContext`
   - `@Roles` metadata 缺失/空 → 403 `AUTHZ_ROLE_METADATA_MISSING`（禁止放行）
   - user 不存在 / INACTIVE / role 不足 → 403
   - DB lookup 异常 → 5xx（不伪装成 403），记 `AUTHZ_ROLE_LOOKUP_FAILED`
   - metadata 读取 `getAllAndOverride`，method 优先于 class
   - 成功 → 挂 `req.authz`（typed `AuthzContext`）
6. typed `AuthzContext` + `@AuthzUser()` decorator（controller 经此读取，禁止重新查 DB）
7. `AuthzFailReason` 枚举（含 `AUTHZ_ROLE_METADATA_MISSING`）
8. `GET /api/admin/me`（ADMIN-only RBAC proof 端点 + P1-007 契约）
9. `AdminController` + `AdminModule`（imports `AuthModule`；不复制 auth 配置）
10. `AuthModule` additive Nest-export `JwtAuthGuard`
11. `AuditService.recordAuthzDecision`（additive；写失败 non-blocking）
12. `AuditService.write` additive 新增 `resource?: string`（默认 `'auth'`）
13. RBAC unit / integration / security / static 测试矩阵
14. Swagger 契约（401/403/500 文档化）
15. 审计/log 不泄露 JWT/cookie/role 具体值（仅 reasonCode + userId）

## OUT Scope

- apps/admin 前端任何改动（P1-007）
- Admin 登录页面 / username/password 认证 / credential 表
- role 写入 JWT payload（禁止）
- Admin 用户管理 / role 修改 API / self-promotion 接口
- `UserUpdateInput` 暴露 role 写入（禁止；generic role mutation 能力不提供）
- 应用代码层任何 role mutation（仅受控 provisioning；未来 role 管理须独立显式 `setRole` 接口）
- SUPER_ADMIN / OPERATOR / FINANCE / 多级权限 / 细粒度 permission
- device / session management（P1-005 deferred G3）
- 资金 / USDT / 充提 / 理财 / 任务 / 团队 / 邀请 / 积分（硬约束禁止）
- P1-007 及以后功能
- 复制 `JwtAuthGuard` / `JwtAuthService` 配置（禁止）
- 新建第二套 auth module / session 体系（禁止）

## Non-Goals

- 不修改 `JwtAuthService.sign/verify` 语义
- 不修改 P1-003~004 cookie/CSRF/transport/refresh 任何逻辑
- 不新增 Prisma 表（仅 enum + 列）
- 不做 role 缓存（每请求实时读 DB；缓存引入 stale 风险，违背 default-deny）
- 不做 HTTP 提权/降权端点
- 不在 `UserUpdateInput` 暴露 role；未来 role 管理须独立显式 `setRole` 接口（后续阶段）

## Security Constraints

- default-deny：admin 路由必须显式 `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(ADMIN)`
- `@Roles` metadata 缺失或空数组 → 403，绝不放行
- role 唯一可信来源 = DB `users.role`；禁止读 header/query/body/cookie 中的 role
- JWT 不携带 role/permission claim
- 授权不足（user 不存在/INACTIVE/role 不足/metadata 缺失）→ 403 FORBIDDEN
- 基础设施故障（DB lookup 异常）→ 5xx INTERNAL_ERROR，记 `AUTHZ_ROLE_LOOKUP_FAILED`，
  不得伪装成权限不足
- fail-closed = 不授权（拒绝放行），其 HTTP 表现按根因区分：403（权限不足）/ 5xx（基础设施故障）
- `AuditLog.metadata` 仅记 reasonCode + resource id；禁止记 token/cookie/secret
- `AuditService` 写失败 non-blocking，不影响授权决定
- provisioning 禁止 HTTP 接口；禁止把具体 wallet/address 写入 migration 源码
- provisioning `AuditLog.actor` 必须为 UUID User ID 或 null；禁止任意字符串（如 `'dba'`）
- provisioning 留痕单一权威源 = 应用 `audit_logs` 表（禁止双权威来源）
- controller 经 `@AuthzUser()` 读 `req.authz`；禁止重新查 DB / 引用不存在的 req 变量

## Implementation-time hardening (A/B)

### A. Prisma migration 物理命名

- 新增 enum `UserRole` 后**禁止手工强制写成 snake_case `user_role`**。
- 当前仓库 enum 物理命名沿用 Prisma 默认（例如 `UserStatus` 无 `@@map`）；
  预期新 enum 使用 `UserRole`（无 `@@map`）。
- 必须检查 `prisma migrate diff`/drift；禁止 schema 与 migration 物理类型名不一致。
- migration SQL 实际生成结果以 `prisma migrate dev` 为准，不得手工篡改类型名。

### B. Provisioning 权威审计原子性

- `UPDATE users.role` + `INSERT audit_logs(AUTHZ_ROLE_GRANTED/REVOKED)` 必须处于
  **同一个 PostgreSQL transaction**。
- 任一失败全部 rollback。
- "同一 change-ticket" 不能替代数据库事务原子性（change-ticket 是流程证据，不是原子性保证）。
- P1-006 不提供 HTTP provisioning 接口；此契约由受控运维 SQL 事务执行。

## Dependencies

- `services/api@8343b3a`（P1-002~005 已合入，不动）
- `packages/database`（schema + migration + repository）
- `packages/shared`（AppError / AuditAction / AuthzFailReason）

## Architecture

### RolesGuard 调用链

```
HTTP Request GET /api/admin/me (Bearer JWT 或 access cookie)
        │
        ▼
[全局] ThrottlerGuard ── 超限 429
        ▼
[全局] CsrfGuard (P1-003) ── GET 豁免
        ▼
[per-route, 顺序1] JwtAuthGuard.canActivate
        │  无 token → 401 UNAUTHORIZED (NOT_AUTHENTICATED)
        │  verify 失败 → 401 (TOKEN_INVALID/...)
        │  成功 → req.auth = { userId, walletId?, jti, token }
        ▼
[per-route, 顺序2] RolesGuard.canActivate
        │  1. 无 req.auth?.userId → 403 AUTHZ_NO_AUTH_CONTEXT
        │  2. required = reflector.getAllAndOverride(ROLES_KEY,
        │       [ctx.getHandler(), ctx.getClass()])   // method 优先 class
        │     undefined 或 [] → 403 AUTHZ_ROLE_METADATA_MISSING（禁止放行）
        │  3. try ctx = repos.user.getAuthorizationContext(auth.userId)
        │     catch → 500 INTERNAL_ERROR (AUTHZ_ROLE_LOOKUP_FAILED)
        │       + audit DENIED（.catch 包裹，non-blocking）
        │       不得伪装成 403
        │  4. ctx === null → 403 AUTHZ_USER_NOT_FOUND
        │  5. ctx.status !== ACTIVE → 403 AUTHZ_USER_INACTIVE
        │  6. !required.includes(ctx.role) → 403 AUTHZ_ROLE_INSUFFICIENT + audit DENIED
        │  7. 通过 → req.authz: AuthzContext = { userId, role, walletId }
        │       + audit ALLOWED
        ▼
AdminController.getMe(@AuthUser() auth, @AuthzUser() authz)
        │  controller 经 @AuthzUser() 读取 req.authz（typed AuthzContext）
        │  禁止重新查 DB；禁止引用 req.user/req.role 等不存在变量
        │  return ok({ userId: authz.userId, role: authz.role,
        │              walletId: authz.walletId ?? null })
        ▼
AllExceptionsFilter → 200 { success:true, data, timestamp }
                  或 500 { success:false, error:{code:'INTERNAL_ERROR'} }（不返 stack）
```

### Export 边界（v2.2 锁定）

- `AuthModule` `@Module` exports 数组：仅 additive 新增 `JwtAuthGuard`（不删现有 exports）。
- `AuthzContext`（interface）与 `@AuthzUser()`（decorator）：仅作为 **TypeScript source export**，
  定义于 `services/api/src/auth/authz-context.ts`；`AdminController`/`AdminModule` 直接 `import`。
- **禁止**把 interface/decorator 放进 Nest `@Module` 的 `exports` 数组。

### 模块 DI

- `AuthModule`（`services/api/src/auth/auth.module.ts`）additive：exports 数组新增 `JwtAuthGuard`。
- `AdminModule`（`services/api/src/admin/admin.module.ts`）：
  `imports: [AuthModule]`，`controllers: [AdminController]`，`providers: [RolesGuard, Repositories]`。
- `AppModule` imports 新增 `AdminModule`。
- 禁止复制 `JwtAuthGuard`/`JwtAuthService` 配置；禁止新建第二套 auth module/session。

## Admin Provisioning（安全运维契约，非代码）

P1-006 不提供任何 HTTP 提权/降权接口。

**唯一权威留痕源 = 应用数据库 `audit_logs` 表**（禁止双权威来源）。
外部工单/DB audit 仅作辅助证据，不得成为第二个 authoritative source。

首次 ADMIN grant/revoke 由受控运维 SQL 事务执行，以下两条必须处于**同一个
PostgreSQL transaction**（任一失败全部 rollback）：

```sql
BEGIN;
  UPDATE users SET role = 'ADMIN' WHERE id = '<targetUserId>';
  INSERT INTO audit_logs (id, actor_user_id, action, resource, request_id, ip,
                          user_agent, metadata, created_at)
    VALUES (
      gen_random_uuid(),
      NULL,                                  -- 外部 provisioning 无应用 session actor
      'AUTHZ_ROLE_GRANTED',                  -- 或 'AUTHZ_ROLE_REVOKED'
      '<targetUserId>',                      -- resource = targetUserId UUID
      NULL,
      NULL,
      NULL,
      jsonb_build_object(
        'method', 'OPS_SQL',
        'operatorRef', '<非敏感运维身份引用>',
        'changeTicket', '<工单号>'
      ),
      now()
    );
COMMIT;
```

Audit 字段约束：

- `actor` = `null`（外部 provisioning 无应用 session actor；`actor` 列为 UUID User ID，禁止 `'dba'`/`'ops'` 等任意字符串）
- `action` = `'AUTHZ_ROLE_GRANTED'` | `'AUTHZ_ROLE_REVOKED'`（string 字段，不入应用 `AuditAction` enum）
- `resource` = `<targetUserId UUID>`
- `metadata` = `{ method: 'OPS_SQL', operatorRef, changeTicket }`
- 禁止 metadata 含 token/cookie/wallet/private data

migration 源码不含具体 wallet/address。4-eye principle + 变更工单。
provisioning 后 ADMIN 通过 `GET /api/admin/me` 自证。

## /api/admin/me API 契约

|                 |                                                                   |
| --------------- | ----------------------------------------------------------------- |
| Method / Path   | `GET /api/admin/me`                                               |
| Auth            | `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(UserRole.ADMIN)` |
| Transport       | Bearer 或 access cookie（JwtAuthGuard 处理）                      |
| CSRF            | GET 豁免                                                          |
| Controller 读取 | `@AuthzUser() authz: AuthzContext`（禁止重新查 DB）               |

### 200 成功（ADMIN）

```json
{
  "success": true,
  "data": { "userId": "...", "role": "ADMIN", "walletId": "..." },
  "timestamp": "2026-08-21T12:00:00.000Z"
}
```

### 401 未认证（JwtAuthGuard）

```json
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "Unauthorized" } }
```

### 403 授权不足（RolesGuard；统一 body，不区分 reason）

适用：metadata 缺失/空、user 不存在、INACTIVE、role 不足。所有 `AUTHZ_*`（除 LOOKUP_FAILED）reason 对客户端不可区分。

```json
{ "success": false, "error": { "code": "FORBIDDEN", "message": "Forbidden" } }
```

### 500 基础设施故障（DB lookup 异常）

```json
{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "Internal Server Error" } }
```

- `reason = AUTHZ_ROLE_LOOKUP_FAILED` 仅日志 + AuditLog.metadata，不返客户端
- 不返 stack / DB 错误 / 内部路径
- 客户端可重试（区别于 403 不可重试）

### DTO

```ts
export class AdminMeResponseDto {
  userId: string;
  role: 'USER' | 'ADMIN';
  walletId: string | null;
}
```

## Threat Model（v2.1 真实残留风险）

### 7.1 Privilege Escalation

| 攻击面                                | 缓解                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| 客户端传 `X-Role: admin` header       | RolesGuard 不读任何 header 的 role；role 仅来自 `getAuthorizationContext()` DB     |
| body `{role:'ADMIN'}` / `?role=admin` | 同上，完全忽略                                                                     |
| JWT 内伪造 role claim                 | JWT payload 不含 role（`sign/verify` 不变）；即便伪造也无解析路径                  |
| 修改 cookie 值                        | JwtAuthGuard.verify 校验签名；role 不从 cookie 读                                  |
| 添加自定义 metadata key               | `@Roles` 经 SetMetadata 从 handler 元数据取，非请求元数据                          |
| 应用代码层 role mutation              | UserRepository 无 setRole/updateRole；UserUpdateInput 不含 role；无 HTTP role 路由 |

### 7.2 Stale Role

| 场景                                   | 行为                                                  |
| -------------------------------------- | ----------------------------------------------------- |
| ADMIN 降为 USER 后旧 access JWT 仍有效 | 每请求 `getAuthorizationContext` 实时读 DB → 立即 403 |
| USER 升为 ADMIN 后无需重签 JWT         | 实时读 DB → 200                                       |
| refresh token 携带 role？              | 不携带；role 始终 DB 实时                             |

trade-off：每 admin 请求一次 DB 读（同时取 role+status）。admin 流量低，可接受；
P1-006 不做缓存（缓存引入 stale 风险，违背 default-deny）。

### 7.3 Forged Role

- 所有客户端输入均不被 RolesGuard 读取
- `@Roles` 元数据在编译期由装饰器固定，运行期不可被请求篡改
- `getAllAndOverride([method, class])` 消歧：method 覆盖 class，二者皆空 → 403

### 7.4 Fail-Open 与故障语义

**核心澄清：fail-closed = 不授权（拒绝放行），不等于 403。** HTTP 表现按根因区分：

| 异常路径                                                 | 决策                                     | HTTP                   | reason                       |
| -------------------------------------------------------- | ---------------------------------------- | ---------------------- | ---------------------------- |
| JwtAuthGuard 未挂 `req.auth`（顺序错/绕过）              | 拒绝                                     | 403                    | AUTHZ_NO_AUTH_CONTEXT        |
| `@Roles` metadata 缺失/空数组                            | 拒绝                                     | 403                    | AUTHZ_ROLE_METADATA_MISSING  |
| `getAuthorizationContext` 返回 null（用户被删）          | 拒绝                                     | 403                    | AUTHZ_USER_NOT_FOUND         |
| `ctx.status !== ACTIVE`                                  | 拒绝                                     | 403                    | AUTHZ_USER_INACTIVE          |
| `!required.includes(role)`                               | 拒绝                                     | 403                    | AUTHZ_ROLE_INSUFFICIENT      |
| **`getAuthorizationContext` 抛 Prisma error（DB 宕机）** | **拒绝**                                 | **500 INTERNAL_ERROR** | **AUTHZ_ROLE_LOOKUP_FAILED** |
| 任何未捕获 throw                                         | AllExceptionsFilter → 500 INTERNAL_ERROR | —                      |

铁律：

- RolesGuard 任何分支不得 `return true` 除非显式通过 `required.includes(role)` 校验。
- 无 `catch → true`、无 `null → true`、无 `default → true`、无 `metadata 缺失 → true`。
- DB lookup 异常必须 5xx，不得伪装成 403——403 语义=权限不足（不可重试），500 语义=基础设施故障（可重试）。
- 500 响应不返 stack/DB 错误/内部路径；`reason=AUTHZ_ROLE_LOOKUP_FAILED` 仅日志 + AuditLog.metadata。

RolesGuard 故障路径签名（v2.2 锁定）：

```ts
await this.audit
  .recordAuthzDecision({
    userId: auth.userId,
    decision: 'DENIED',
    reason: AuthzFailReason.AUTHZ_ROLE_LOOKUP_FAILED,
    resource: 'admin/me',
    requestId: req.id,
    ip: req.ip,
    userAgent: req.headers?.['user-agent'],
  })
  .catch(() => {}); // non-blocking

throw AppError.internal('Internal Server Error', {
  reason: AuthzFailReason.AUTHZ_ROLE_LOOKUP_FAILED,
});
```

禁止 `AppError.internal(500, ...)`（签名不存在；真实签名见
`packages/shared/src/error-codes.ts` `internal(message?, opts?)`）。

### 7.5 信息泄露

- 403 body 统一 `{code:FORBIDDEN}`，不区分 `AUTHZ_*` reason → 防枚举
- 500 body 统一 `{code:INTERNAL_ERROR}`，不泄露 DB 错误细节
- `reason` 仅写 AuditLog.metadata + 服务端日志，不进 HTTP 响应
- AuditLog 不记 token/cookie/signature/wallet 私钥；仅 `reasonCode + userId + resource`
- 日志遵循 P1-002 约定（token itself is never logged）

### 7.6 Audit 链路鲁棒性

- `AuditService.recordAuthzDecision` 内部 try/catch，写失败仅 `logger.warn`，不抛
- RolesGuard 调用 audit 用 `.catch(() => {})` 包裹 → 即使审计 DB 也宕机，授权决定不受影响
- provisioning 留痕单一权威源（应用 `audit_logs`），禁止双权威来源

### 7.7 真实残留风险（v2.1 修正）

本阶段 RBAC 地基**不能消除**以下风险，仅通过纵深防御缓解：

1. **DB / ops 凭据失陷**：拥有 DB 写权限或 ops 凭据的攻击者可直接 `UPDATE users SET role='ADMIN'`。
   缓解：least privilege、4-eye principle、ops 凭据 MFA + 跳板机 + 审计。
2. **错误 provisioning（误授/误降）**：DBA 手抖把 ADMIN 授给错误 userId，或误降合法 ADMIN。
   缓解：provisioning 必须有 change-ticket + operatorRef 留痕、4-eye 复核、变更前后 `SELECT` 二次确认、
   变更后 ADMIN 通过 `/api/admin/me` 自证。
3. **开发者遗漏 Guard**：未来新增 admin 路由时开发者忘记 `@UseGuards(JwtAuthGuard, RolesGuard) + @Roles(ADMIN)`。
   缓解：default-deny 文化 + CI 静态检查 + code review 强制 checklist。
4. **role 列被旁路写入**：若未来有其他服务/脚本直接写 `users.role`（绕过 provisioning 契约）。
   缓解：DB 层 GRANT 收紧 role 列写权限仅限 provisioning 账户、AuditLog 监控非 OPS_SQL 的 role 变更、定期对账。
5. **DB lookup 间歇性故障**：高峰期 DB 抖动导致 admin 端点 500 风暴。
   缓解：5xx 语义正确（客户端可重试）、监控告警区分 403/500。

缓解总原则：least privilege + 4-eye + default-deny + CI/review 纵深防御。
残留风险**接受**（admin 流量低、provisioning 频率极低），并在后续阶段持续收紧。

## Acceptance Criteria

| AC#   | 验收项                                                                                                                                                | 验证方式                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| AC-1  | `UserRole` enum 仅含 `{USER, ADMIN}`，无 `@@map`（沿用 Prisma 默认物理名 `UserRole`）                                                                 | schema review                              |
| AC-2  | `User.role` 列存在，`@default(USER)`，NOT NULL                                                                                                        | migration + DB 查询                        |
| AC-3  | migration 后所有存量用户 `role='USER'`                                                                                                                | `SELECT COUNT(*) WHERE role<>'USER'` = 0   |
| AC-4  | migration 为 additive，不触碰 P1-002~005 对象；无 schema/migration drift（A）                                                                         | migration.sql diff + `prisma migrate diff` |
| AC-5  | JWT payload 不含 role/permission claim（sign/verify 零改动）                                                                                          | git diff jwt-auth.service.ts 无业务改动    |
| AC-6  | `@Roles` 装饰器经 SetMetadata 注入，运行期不可被请求篡改                                                                                              | 代码 review + 单元                         |
| AC-7  | RolesGuard 依赖 `req.auth.userId`，不读 header/query/body role                                                                                        | 代码 review + 单元                         |
| AC-8  | metadata 读取用 `getAllAndOverride([method, class])`，method 优先 class                                                                               | 代码 review + 单元                         |
| AC-9  | `@Roles` metadata 缺失（无装饰器）→ 403 AUTHZ_ROLE_METADATA_MISSING                                                                                   | 单元                                       |
| AC-10 | `@Roles()` 空数组 → 403 AUTHZ_ROLE_METADATA_MISSING                                                                                                   | 单元                                       |
| AC-12 | `getAuthorizationContext` 单次 DB 查询同时取 role+status                                                                                              | spy 调用次数=1                             |
| AC-13 | 未认证访问 `/admin/me` → 401                                                                                                                          | 集成                                       |
| AC-14 | USER 有效 session → 403                                                                                                                               | 集成                                       |
| AC-15 | ADMIN 有效 session → 200 `{userId, role:'ADMIN', walletId}`                                                                                           | 集成                                       |
| AC-16 | 伪造 role header/body/query → 不影响授权决策（仍按 DB）                                                                                               | 集成+单元                                  |
| AC-17 | DB role USER→ADMIN 后无需重签 JWT → 200                                                                                                               | 集成                                       |
| AC-18 | DB role ADMIN→USER 后旧 JWT 仍有效 → 立即 403                                                                                                         | 集成                                       |
| AC-19 | user 不存在 → 403 AUTHZ_USER_NOT_FOUND                                                                                                                | 单元                                       |
| AC-20 | status !== ACTIVE → 403 AUTHZ_USER_INACTIVE                                                                                                           | 单元                                       |
| AC-21 | role 不足 → 403 AUTHZ_ROLE_INSUFFICIENT                                                                                                               | 单元                                       |
| AC-22 | DB lookup 异常 → 500 INTERNAL_ERROR（reason=AUTHZ_ROLE_LOOKUP_FAILED），调用 `AppError.internal('Internal Server Error', { reason })`；非 403，非 502 | 单元+集成                                  |
| AC-23 | 500 响应不返 stack/DB 错误/内部路径                                                                                                                   | 响应断言                                   |
| AC-24 | RolesGuard 无 auth context → 403 AUTHZ_NO_AUTH_CONTEXT（不冒充 401）                                                                                  | 单元                                       |
| AC-25 | 403 响应体统一 `{code:FORBIDDEN}`，不泄露 `AUTHZ_*` reason                                                                                            | 响应断言                                   |
| AC-26 | AuditLog.metadata 仅 `{reasonCode}`，无 token/cookie/secret/重复 resource                                                                             | AuditLog 查询                              |
| AC-27 | AuditService 写失败 → RolesGuard 仍正常抛 403/500，不受影响                                                                                           | 单元                                       |
| AC-28 | P1-002~005 现有 API 测试全部 PASS                                                                                                                     | CI test                                    |
| AC-29 | `/auth/me` `/auth/refresh` `/auth/logout` SIWE/cookie/CSRF 语义不变                                                                                   | 回归                                       |
| AC-30 | `/api/docs` 出现 admin tag + `/admin/me` + 401/403/500                                                                                                | Swagger                                    |
| AC-31 | AuthModule `@Module` exports 数组仅 additive 新增 `JwtAuthGuard`                                                                                      | git diff auth.module.ts                    |
| AC-32 | AdminModule `imports: [AuthModule]`，providers=`RolesGuard, Repositories`                                                                             | 代码 review                                |
| AC-33 | 未复制 JwtAuthGuard/JwtAuthService 配置；未新建第二套 auth module                                                                                     | 代码 review                                |
| AC-34 | 无 HTTP 提权/降权/self-promotion 端点                                                                                                                 | 代码 review                                |
| AC-35 | migration 源码不含具体 wallet/address                                                                                                                 | secret-scan + review                       |
| AC-36 | provisioning 仅定义运维契约（SQL + AuditLog + 4-eye），无代码                                                                                         | spec review                                |
| AC-37 | lint / typecheck / test / build / secret-scan / docker-build / CI gate / CodeQL 全绿                                                                  | CI                                         |
| AC-38 | 不自动 merge PR                                                                                                                                       | 流程                                       |
| AC-39 | `UserUpdateInput` 不含 `role` 字段（仅 status/lastLoginAt）                                                                                           | 类型断言                                   |
| AC-40 | UserRepository 无 `setRole`/`updateRole` 方法                                                                                                         | grep 断言                                  |
| AC-41 | 无 HTTP role mutation 路由（`/role` 无 PUT/PATCH/POST）                                                                                               | grep 断言                                  |
| AC-42 | `AuthzContext` typed interface 存在（userId/role/walletId?）                                                                                          | 代码 review                                |
| AC-43 | `@AuthzUser()` decorator 存在，参照 @AuthUser 模式                                                                                                    | 代码 review                                |
| AC-44 | RolesGuard 成功后挂 `req.authz: AuthzContext`                                                                                                         | 单元断言                                   |
| AC-45 | AdminController 经 `@AuthzUser()` 读取，不重新查 DB（getAuthorizationContext 总调用=1）                                                               | spy 断言                                   |
| AC-46 | provisioning AuditLog.actor=null（非 'dba' 等）；metadata 仅 {method, operatorRef, changeTicket}                                                      | 契约 review                                |
| AC-47 | provisioning 留痕**唯一**权威源 = 应用 `audit_logs` 表；UPDATE+INSERT 同一 PostgreSQL transaction；禁止双权威来源                                     | 契约 review                                |
| AC-48 | provisioning action=`AUTHZ_ROLE_GRANTED`/`REVOKED` 为 string 字段，不入应用 AuditAction enum                                                          | enum review                                |
| AC-49 | 威胁模型 §7.7 含真实残留风险 + 缓解措施                                                                                                               | spec review                                |
| AC-50 | `AuthModule` `@Module` exports 数组仅 additive 新增 `JwtAuthGuard`；`AuthzContext`/`@AuthzUser()` 为 TS source export，不在 `@Module` exports 数组    | 代码 review                                |
| AC-51 | `AuditService.write` params 新增 optional `resource?: string`；DB 写入 `resource ?? 'auth'`；旧 login/logout/refresh 审计 `resource='auth'` 不变      | 代码 review + 回归                         |
| AC-52 | `recordAuthzDecision` 传 `resource='admin/me'`；RBAC denied/allowed 审计 `resource='admin/me'`；metadata 仅 `{reasonCode}`，不重复 resource           | 单元                                       |
| AC-53 | RBAC audit metadata 不含 token/cookie/wallet/private；`reasonCode` 正确反映 `AUTHZ_ROLE_*`                                                            | 单元                                       |
| AC-54 | 旧 auth 审计（login/logout/refresh）`resource='auth'` 回归测试通过                                                                                    | 回归                                       |
| AC-55 | audit 写失败仍 non-blocking（`logger.warn` 不抛），RolesGuard 正常抛 403/500                                                                          | 单元                                       |
