# P1-006 — Backend RBAC Foundation Tasks

> Spec contract: see `spec.md` (v2.1 + v2.2 + implementation hardening A/B).
> Baseline: `origin/develop@8343b3ad473e11396f1a1f57f4418718ca459cea`

## T01 — Prisma schema：UserRole enum + User.role

- `packages/database/prisma/schema.prisma`：
  - 新增 `enum UserRole { USER ADMIN }`（**无 `@@map`**，沿用 Prisma 默认物理名 `UserRole`）
  - `User` 新增 `role UserRole @default(USER)`
- 禁止 SUPER_ADMIN 等额外值

## T02 — Prisma migration（additive, drift-free；hardening A）

- `pnpm --filter @ai-wealth/database exec prisma migrate dev --name p1_006_user_role`
- 产物以 `prisma migrate dev` 实际生成为准；**禁止手工篡改 enum 物理类型名**（不得强制 snake_case `user_role`）
- 校验 `prisma migrate diff` 无 schema/migration drift
- 存量行全部 USER（NOT NULL DEFAULT 'USER' 已保证；显式 UPDATE 兜底）
- additive：不 DROP、不改类型、不动现有列/表 → P1-002~005 零回归风险

## T03 — UserRepository.getAuthorizationContext（单次查询；不暴露 role 写入）

- `packages/database/src/repositories/user.repository.ts` 新增：
  ```ts
  export interface AuthorizationContext { role: UserRole; status: UserStatus; }
  async getAuthorizationContext(id: string): Promise<AuthorizationContext | null> {
    const row = await this.db.user.findUnique({
      where: { id },
      select: { role: true, status: true },
    });
    return row ?? null;
  }
  ```
- 删除 v1 的 `getRole` 方案（不实现）
- `findById` 返回的 `User` 自动含 role（Prisma client 已含新列，仅读取投影，非 mutation）
- `UserUpdateInput` 保持 v1 原样（仅 `status?: UserStatus` / `lastLoginAt?: Date | null`）；**严禁新增 `role?: UserRole`**
- 不新增任何 role 写入方法（无 `setRole`/`updateRole`）；未来 role 管理须独立显式接口（后续阶段）
- 禁止 role/status 两次 DB 查询

## T04 — AuthzFailReason 枚举 + AuditAction 增补

- `packages/shared/src/error-codes.ts` 新增：
  ```ts
  export enum AuthzFailReason {
    AUTHZ_NO_AUTH_CONTEXT = 'AUTHZ_NO_AUTH_CONTEXT',
    AUTHZ_ROLE_METADATA_MISSING = 'AUTHZ_ROLE_METADATA_MISSING',
    AUTHZ_USER_NOT_FOUND = 'AUTHZ_USER_NOT_FOUND',
    AUTHZ_USER_INACTIVE = 'AUTHZ_USER_INACTIVE',
    AUTHZ_ROLE_INSUFFICIENT = 'AUTHZ_ROLE_INSUFFICIENT',
    AUTHZ_ROLE_LOOKUP_FAILED = 'AUTHZ_ROLE_LOOKUP_FAILED', // 5xx，非 403
  }
  ```
- `AuditAction` 增补（additive，仅应用 RBAC 决策审计）：
  - `AUTHZ_DECISION_DENIED = 'AUTHZ_DECISION_DENIED'`
  - `AUTHZ_DECISION_ALLOWED = 'AUTHZ_DECISION_ALLOWED'`（可选，仅成功 admin 访问）
- 说明：provisioning ops action（`AUTHZ_ROLE_GRANTED`/`REVOKED`）不加入应用 `AuditAction` enum
  —— `AuditLog.action` DB 字段为 string，可写任意值；provisioning 由外部受控 SQL 事务写入，非应用代码路径
- 禁止 rename 现有值

## T05 — @Roles 装饰器

- 新建 `services/api/src/auth/roles.decorator.ts`
  ```ts
  export const ROLES_KEY = 'roles';
  export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
  ```
- 注意：空数组 `@Roles()` 合法但 RolesGuard 判定为 metadata 缺失 → 403

## T06 — AuthzContext + @AuthzUser() decorator（TS source export）

- 新建 `services/api/src/auth/authz-context.ts`
  ```ts
  export interface AuthzContext {
    userId: string;
    role: UserRole;
    walletId?: string;
  }
  export const AuthzUser = createParamDecorator(
    (_data: unknown, ctx: ExecutionContext): AuthzContext | undefined => {
      const req = ctx.switchToHttp().getRequest();
      return req.authz;
    },
  );
  ```
- 参照现有 `@AuthUser()` 模式（`jwt-auth.guard.ts` L98-103）
- **仅 TypeScript source export**；禁止放入 Nest `@Module` exports 数组

## T07 — RolesGuard（default-deny + 单次查询 + 故障语义 v2.2）

- 新建 `services/api/src/auth/roles.guard.ts`
- `@Injectable() implements CanActivate`
- 构造注入 `Repositories` + `Reflector` + `AuditService`
- canActivate 伪代码（权威实现见 spec.md §Architecture）：
  1. 无 `req.auth?.userId` → `AppError.forbidden(403, AUTHZ_NO_AUTH_CONTEXT)`
  2. `required = reflector.getAllAndOverride(ROLES_KEY, [handler, class])`；undefined/空 → `AppError.forbidden(403, AUTHZ_ROLE_METADATA_MISSING)`（禁止 return true）
  3. `try authz = repos.user.getAuthorizationContext(userId)`；catch → `AppError.internal('Internal Server Error', { reason: AUTHZ_ROLE_LOOKUP_FAILED })` + audit DENIED（`.catch(()=>{})`）；**禁止伪装成 403**
  4. `authz === null` → `AppError.forbidden(403, AUTHZ_USER_NOT_FOUND)`
  5. `authz.status !== 'ACTIVE'` → `AppError.forbidden(403, AUTHZ_USER_INACTIVE)`
  6. `!required.includes(authz.role)` → `AppError.forbidden(403, AUTHZ_ROLE_INSUFFICIENT)` + audit DENIED
  7. 通过 → `req.authz = { userId, role, walletId }` + audit ALLOWED
- 禁止读 header/query/body 的 role
- 禁止任何 catch→true / null→true / default→true / metadata 缺失→true
- 禁止 `AppError.internal(500, ...)`（签名不存在）

## T08 — AuditService 扩展（write resource + recordAuthzDecision；v2.2）

- `services/api/src/auth/audit.service.ts` additive 修改：
  - `write()` params 新增 `resource?: string`；DB 写入 `resource: params.resource ?? 'auth'`（保 P1-002~005 旧 auth 审计 `resource='auth'` 不变）
  - 新增 public `recordAuthzDecision(params: { userId?; decision: 'ALLOWED'|'DENIED'; reason?: AuthzFailReason|string; resource: string; requestId?; ip?; userAgent? })`
    → 调 `write(AUTHZ_DECISION_DENIED|ALLOWED, { actor: userId, resource, requestId, ip, userAgent, metadata: { reasonCode: reason } })`
  - metadata 仅 `{ reasonCode }`；禁止重复塞 resource（resource 是独立列）；禁止 token/cookie/wallet/private
  - 写失败 `logger.warn` 不抛（non-blocking）；RolesGuard 调用用 `.catch(()=>{})` 包裹
- 不改现有方法签名/语义

## T09 — AuthModule additive Nest-export JwtAuthGuard

- `services/api/src/auth/auth.module.ts`：
  - `exports` 数组 additive 新增 `JwtAuthGuard`（不删现有 exports，不改 providers 配置）
  - 不重复 `JwtModule.registerAsync` 配置
  - **`AuthzContext`/`@AuthzUser()` 不入 `@Module` exports**（TS source export，由 `authz-context.ts` 直接 import）

## T10 — AdminController + GET /api/admin/me

- 新建 `services/api/src/admin/admin.controller.ts`
  ```ts
  @ApiTags('admin') @ApiBearerAuth()
  @Controller('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)   // 固定顺序
  export class AdminController {
    @Get('me')
    @Roles(UserRole.ADMIN)
    @ApiOperation(...) @ApiResponse(200) @ApiResponse(401) @ApiResponse(403) @ApiResponse(500)
    async getMe(
      @AuthUser() auth: AuthContext,
      @AuthzUser() authz: AuthzContext,      // 经 decorator 读取，禁止重新查 DB
    ): Promise<ApiSuccessResponse<AdminMeResponseDto>> {
      return ok({ userId: authz.userId, role: authz.role, walletId: authz.walletId ?? null });
    }
  }
  ```
- 新建 `AdminMeResponseDto`（userId/role/walletId）
- controller 不注入 `Repositories`；不调用任何 `user.*` 查询

## T11 — AdminModule + AppModule 装配

- 新建 `services/api/src/admin/admin.module.ts`
  ```ts
  @Module({
    imports: [AuthModule],
    controllers: [AdminController],
    providers: [RolesGuard, Repositories],
  })
  export class AdminModule {}
  ```
- `services/api/src/app.module.ts` imports 新增 `AdminModule`
- 禁止复制 `JwtAuthGuard`/`JwtAuthService` 配置；禁止新建第二套 auth module/session

## T12 — 单元测试（RolesGuard）

- 无 auth context → 403 AUTHZ_NO_AUTH_CONTEXT
- `@Roles` metadata 缺失（无装饰器）→ 403 AUTHZ_ROLE_METADATA_MISSING
- `@Roles()` 空数组 → 403 AUTHZ_ROLE_METADATA_MISSING
- `getAuthorizationContext` 返回 null → 403 AUTHZ_USER_NOT_FOUND
- status !== ACTIVE → 403 AUTHZ_USER_INACTIVE
- role=USER 访问 @Roles(ADMIN) → 403 AUTHZ_ROLE_INSUFFICIENT
- role=ADMIN 访问 @Roles(ADMIN) → true + `req.authz` 挂 typed AuthzContext
- `getAuthorizationContext` 抛 Prisma error → 500 INTERNAL_ERROR（reason=AUTHZ_ROLE_LOOKUP_FAILED）；断言抛的是 `AppError.internal`，非 forbidden
- 伪造 header `X-Role:ADMIN` / body.role / `?role=admin` → 仍按 DB 判定
- metadata 读取：method 级 @Roles 覆盖 class 级；二者均空 → 403
- `getAuthorizationContext` 单次调用（spy 调用次数=1）
- `req.authz` 类型为 AuthzContext（断言含 userId/role/walletId?）

## T13 — 集成测试（AdminController /api/admin/me）

- 未带 token → 401（JwtAuthGuard）
- USER 有效 session → 403
- ADMIN 有效 session → 200 `{ userId, role:'ADMIN', walletId }`
- DB 查 role+status 抛错 → 500 INTERNAL_ERROR（非 403，非 502）
- 伪造 role header → 403（USER）/ 200（ADMIN），role 仅取 DB
- controller 未重新查 DB（spy 断言 `getAuthorizationContext` 仅被 RolesGuard 调 1 次，controller 内无 `user.*` 调用）
- 集成测试：`DATABASE_URL` 非本地 → `describe.skip`（遵循现有约定）

## T14 — 回归测试

- P1-002~005 现有 API 测试全绿（AC-28）
- `/auth/me` `/auth/refresh` `/auth/logout` SIWE/cookie/CSRF 语义不变（AC-29）
- cookie/CSRF/SIWE/refresh rotation 不受影响

## T15 — Migration 验证

- backfill 后 `SELECT COUNT(*) FROM users WHERE role<>'USER'` = 0（AC-3/17）
- 新建用户默认 role=USER
- `prisma migrate diff` 无 drift（AC-4/18）

## T16 — Swagger / 文档

- `/api/docs` 出现 admin tag + `/admin/me`（AC-30）
- 401/403/500 文档化

## T17 — 静态/契约验证

- `UserRepository` 无 `setRole`/`updateRole` 方法（grep 断言，AC-40）
- `UserUpdateInput` 不含 `role` 字段（类型断言，AC-39）
- 无 HTTP role mutation 路由（grep `/role` 无 PUT/PATCH/POST，AC-41）
- provisioning 仅定义契约，无应用代码（AC-36）

## T18 — Audit 验证（v2.2）

- 旧 auth 审计（login/logout/refresh）`resource='auth'`（AC-51/54）
- RBAC denied/allowed 审计 `resource='admin/me'`（AC-52）
- `reasonCode` 正确反映 `AUTHZ_ROLE_*`（AC-53）
- audit 写失败仍 non-blocking（`logger.warn` 不抛），RolesGuard 正常抛 403/500（AC-55）
- metadata 仅 `{reasonCode}`，不重复 resource，无 token/cookie/wallet/private（AC-26/52/53）

## T19 — CI gate

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` / secret-scan / docker-build / CI gate / CodeQL 全绿（AC-37）
- 不自动 merge PR（AC-38）

## 测试矩阵（必须覆盖，对应用户必测 1-19）

| #   | 场景                                          | 预期                            | 层        |
| --- | --------------------------------------------- | ------------------------------- | --------- |
| 1   | 未认证访问 `/admin/me`                        | 401                             | 集成      |
| 2   | USER 有效 session                             | 403                             | 集成      |
| 3   | ADMIN 有效 session                            | 200                             | 集成      |
| 4   | 伪造 role header/body/query                   | 仍按 DB                         | 集成+单元 |
| 5   | DB role USER→ADMIN 后旧 JWT                   | 200                             | 集成      |
| 6   | DB role ADMIN→USER 后旧 JWT                   | 立即 403                        | 集成      |
| 7   | inactive → 403                                | 403 AUTHZ_USER_INACTIVE         | 单元      |
| 8   | metadata 缺失/空 → 403                        | 403 AUTHZ_ROLE_METADATA_MISSING | 单元      |
| 9   | DB lookup error → 500                         | 500 INTERNAL_ERROR              | 单元+集成 |
| 10  | getAuthorizationContext 每请求仅 1 次         | spy=1                           | 单元+集成 |
| 11  | controller 无第二次 user DB 查询              | spy=1 总计                      | 集成      |
| 12  | generic/application role mutation 不存在      | grep+类型                       | 静态      |
| 13  | 旧 login/logout/refresh audit resource='auth' | 断言                            | 回归      |
| 14  | RBAC audit resource='admin/me'                | 断言                            | 单元      |
| 15  | reasonCode 正确                               | 断言                            | 单元      |
| 16  | audit 失败 non-blocking                       | 断言                            | 单元      |
| 17  | migration 存量用户全部 USER                   | SELECT COUNT=0                  | migration |
| 18  | Prisma migration 无 drift                     | migrate diff                    | 静态      |
| 19  | P1-002~005 全部 API 回归通过                  | CI                              | 回归      |
