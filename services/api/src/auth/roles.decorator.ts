// ============================================================================
// @Roles() — P1-006 Backend RBAC role requirement decorator.
//
// Sets metadata consumed by RolesGuard via Reflector.getAllAndOverride
// (method-level wins over class-level). An EMPTY array (`@Roles()`) or a
// missing decorator is treated by RolesGuard as AUTHZ_ROLE_METADATA_MISSING →
// 403 (default-deny: admin routes MUST declare their required roles explicitly).
// ============================================================================

import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@ai-wealth/database';

export const ROLES_KEY = 'roles';

/**
 * Declare the roles allowed to access a route/controller.
 * Always pass an explicit, non-empty list, e.g. `@Roles(UserRole.ADMIN)`.
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
