// ============================================================================
// AdminModule — P1-006 Backend RBAC admin endpoints.
//
// imports AuthModule to reuse JwtAuthGuard (and the AuthModule DI graph:
// JwtAuthService / JwtModule) WITHOUT re-declaring or copying any auth
// configuration. There is no second auth/session system here.
//
// providers: RolesGuard + Repositories (the aggregate root RolesGuard injects
// to call user.getAuthorizationContext). AdminController is a route consumer
// only — it does not inject Repositories.
//
// AuthzContext + @AuthzUser() are imported directly from ../auth/authz-context
// (TypeScript source export), NOT via @Module exports — they are compile-time
// symbols, not injectable providers.
// ============================================================================

import { Module } from '@nestjs/common';
import { Repositories } from '@ai-wealth/database';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/roles.guard';
import { AdminController } from './admin.controller';

@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [RolesGuard, Repositories],
})
export class AdminModule {}
