// ============================================================================
// AdminController — P1-006 Backend RBAC proof endpoint.
//
// GET /api/admin/me is the ONLY route here in P1-006. It is a default-deny
// admin endpoint guarded by JwtAuthGuard (authentication) + RolesGuard
// (authorization, requires @Roles(UserRole.ADMIN)). It serves two purposes:
//   1. RBAC proof — a 200 proves the caller is authenticated AND an ADMIN
//      (a USER gets 403, an unauthenticated caller gets 401, a DB outage
//      surfaces as 500).
//   2. P1-007 contract — the minimal shape Admin Auth Integration will consume.
//
// The controller reads authorization context via @AuthzUser() (set by
// RolesGuard after its single live-DB role lookup). It does NOT inject
// Repositories and does NOT re-query the user — the role it returns is the
// live DB value resolved inside RolesGuard, not a JWT claim.
//
// No role-mutation endpoints exist here (P1-006 forbids HTTP role changes /
// self-promotion). Provisioning happens only via the controlled ops SQL
// transaction defined in the spec.
// ============================================================================

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ok } from '@ai-wealth/shared';
import type { ApiSuccessResponse } from '@ai-wealth/shared';
import { UserRole } from '@ai-wealth/database';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthzUser } from '../auth/authz-context';
import type { AuthzContext } from '../auth/authz-context';
import { AdminMeResponseDto } from './dto/admin-me-response.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  @Get('me')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin RBAC proof — returns the current admin identity.' })
  @ApiResponse({ type: AdminMeResponseDto, status: 200, description: 'Caller is an ADMIN.' })
  @ApiResponse({ status: 401, description: 'Not authenticated (no/invalid JWT).' })
  @ApiResponse({
    status: 403,
    description: 'Authenticated but not an ADMIN (USER / inactive / forbidden).',
  })
  @ApiResponse({
    status: 500,
    description: 'Authorization DB lookup failure (infrastructure fault).',
  })
  async getMe(@AuthzUser() authz: AuthzContext): Promise<ApiSuccessResponse<AdminMeResponseDto>> {
    // authz was resolved live from the DB by RolesGuard (single query). No
    // second user lookup here. walletId reflects the authenticated session
    // (Bearer-only clients may have none → null).
    return ok({
      userId: authz.userId,
      role: authz.role,
      walletId: authz.walletId ?? null,
    });
  }
}
