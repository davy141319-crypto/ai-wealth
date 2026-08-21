// ============================================================================
// AuthModule — bundles Nonce / SIWE validator / JWT signer / Audit service.
//
// Wires:
//   - JwtModule with `registerAsync` (secret from env().jwtSecret; default
//     exp from env().jwtExpiresIn). HS256 only.
//   - RedisService (global) for session registry + blocklist.
//   - Controllers + providers. No database providers here — Repositories is
//     newed up directly (or injected via Repositories class when needed).
//   - Inline Repositories provider token for direct injection by consumers
//     (NonceService, AuditService) which use DI fallback `= new Repositories()`.
// ============================================================================

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { env } from '@ai-wealth/config';
import { NonceService } from './nonce.service';
import { SiweService } from './siwe.service';
import { JwtAuthService } from './jwt-auth.service';
import { AuditService } from './audit.service';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CookieAuthService } from './cookie-auth.service';
import { CsrfService } from './csrf.service';
import { CsrfGuard } from './csrf.guard';
import { RefreshTokenService } from './refresh-token.service';
import { TransportMiddleware } from './transport.middleware';
import { LogoutGuard } from './logout.guard';
import { APP_GUARD } from '@nestjs/core';
import { Repositories } from '@ai-wealth/database';

/**
 * Convert zeit/ms-style strings ('15m' / '1h' / '30s' / '900') to integer seconds.
 * Falls back to 900 seconds when the format is unknown so auth never fails at
 * module boot.
 */
export function parseDurationToSeconds(input: string | number | undefined): number {
  const fallback = 15 * 60;
  if (input === undefined || input === null) return fallback;
  if (typeof input === 'number') return Math.max(1, Math.floor(input));
  const match = /^\s*(\d+)\s*([smhdSMHD]?)\s*$/.exec(input);
  if (!match) {
    const asInt = parseInt(input, 10);
    if (!Number.isNaN(asInt) && asInt > 0) return asInt;
    return fallback;
  }
  const n = parseInt(match[1], 10);
  const unit = (match[2] || 's').toLowerCase();
  switch (unit) {
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    case 's':
    default:
      return n;
  }
}

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => {
        const e = env();
        // Translate the default expiresIn (e.g. '15m') into seconds here so
        // the factory returns a plain number — NestJS JwtModule typing is
        // strict about `number | StringValue` at compile time.
        const defaultSec = parseDurationToSeconds(e.jwtExpiresIn);
        return {
          secret: e.jwtSecret,
          signOptions: { algorithm: 'HS256' as const, expiresIn: defaultSec },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    // Repositories is a class-based aggregate root. DI injects a new instance
    // for NonceService / AuditService. Inside `Repositories.transaction`,
    // a separate Repositories bound to the transaction client is spawned.
    Repositories,
    NonceService,
    SiweService,
    JwtAuthService,
    AuditService,
    AuthService,
    CookieAuthService,
    CsrfService,
    // P1-004: rotating refresh tokens with token-family reuse detection.
    RefreshTokenService,
    // P1-004: transport mode + Origin anti-downgrade middleware.
    TransportMiddleware,
    // P1-004: logout credential resolver (constraint B — does not throw).
    LogoutGuard,
    // Route-level guard (opted-in via @UseGuards on controllers).
    JwtAuthGuard,
    // Global CSRF guard — enforces Double Submit Cookie on state-changing
    // requests only when an access cookie is present (Bearer-only clients are
    // exempt). See csrf.guard.ts for the exemption rules.
    { provide: APP_GUARD, useClass: CsrfGuard },
    // APP_GUARD for throttler is already installed globally at AppModule.
    // Do NOT install a global JwtAuthGuard APP_GUARD — /auth/nonce and
    // /auth/verify plus /health must remain open.
  ],
  exports: [
    JwtAuthService,
    AuthService,
    NonceService,
    AuditService,
    RefreshTokenService,
    JwtModule,
    // P1-006 — Backend RBAC: expose JwtAuthGuard so AdminModule (which imports
    // AuthModule) can apply it on admin routes WITHOUT re-declaring the guard
    // or re-registering JwtModule/JwtAuthService. AuthzContext + @AuthzUser()
    // are TypeScript source exports from ./authz-context (NOT Nest exports —
    // interfaces/decorators are compile-time symbols, not injectable providers).
    JwtAuthGuard,
  ],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // P1-004: TransportMiddleware runs BEFORE the global CsrfGuard for the
    // auth routes that declare a transport mode (verify/refresh/logout). It
    // enforces X-Auth-Transport + Origin anti-downgrade + constraint A
    // (api transport must not carry auth cookies), so CsrfGuard only ever sees
    // a consistent transport decision.
    consumer.apply(TransportMiddleware).forRoutes('auth/verify', 'auth/refresh', 'auth/logout');
  }
}
