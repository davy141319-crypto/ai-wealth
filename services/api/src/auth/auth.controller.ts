// ============================================================================
// AuthController — 4 endpoints under /auth (/api prefix via global config).
//
// All endpoints:
//   - return the unified ApiResponse envelope { success, data, timestamp }
//   - write AuditLog for success/failure/logout (delegated to services)
//   - throttle: GET nonce (30/min IP, 10/min address)
//                POST verify (20/min IP, 10/min address)
//                POST logout / GET me (120/min same global default)
//
// Controller stays thin (routing + DTO + envelope only); all the orchestration
// lives in AuthService + its domain collaborators.
// ============================================================================

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  Query,
  Res,
  UseGuards,
  Headers,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { Chain } from '@ai-wealth/database';
import { ok } from '@ai-wealth/shared';
import type { ApiSuccessResponse } from '@ai-wealth/shared';
import { AuthService } from './auth.service';
import { AuditService } from './audit.service';
import { JwtAuthService } from './jwt-auth.service';
import { AuthContext, AuthUser, JwtAuthGuard } from './jwt-auth.guard';
import { CookieAuthService } from './cookie-auth.service';
import { CsrfService } from './csrf.service';
import { NonceQueryDto, NonceResponseDto } from './dto/nonce-query.dto';
import { MeResponseDto, VerifyRequestDto, VerifyResponseDto } from './dto/verify-request.dto';
import { CsrfTokenResponseDto } from './dto/csrf-token.dto';
import { NonceService } from './nonce.service';
import { parseDurationToSeconds } from './auth.module';
import { env } from '@ai-wealth/config';

const HEADER_REQUEST_ID = 'x-request-id';
const HEADER_USER_AGENT = 'user-agent';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly nonceService: NonceService,
    private readonly jwtAuth: JwtAuthService,
    private readonly audit: AuditService,
    private readonly cookieAuth: CookieAuthService,
    private readonly csrf: CsrfService,
  ) {}

  // --------------------------------------------------------------------------
  // GET /auth/csrf-token — issues a Double Submit Cookie CSRF token.
  // --------------------------------------------------------------------------
  @Get('csrf-token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Issue a CSRF token (Double Submit Cookie) for state-changing requests.',
  })
  @ApiResponse({ type: CsrfTokenResponseDto, status: 200 })
  getCsrfToken(
    @Res({ passthrough: true }) res: Response,
  ): ApiSuccessResponse<CsrfTokenResponseDto> {
    const token = this.csrf.generateToken();
    // Non-HttpOnly cookie so the browser can read it and echo it back in the
    // X-CSRF-TOKEN header. Same Secure/SameSite/Path as the access cookie.
    this.cookieAuth.setCsrfCookie(res, token);
    return ok({ csrfToken: token });
  }

  // --------------------------------------------------------------------------
  // GET /auth/nonce
  // --------------------------------------------------------------------------
  @Get('nonce')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Request a fresh SIWE nonce challenge bound to (address,chain,network).',
  })
  @ApiResponse({ type: NonceResponseDto, status: 200 })
  async getNonce(@Query() query: NonceQueryDto): Promise<ApiSuccessResponse<NonceResponseDto>> {
    const issue = await this.nonceService.issue({
      address: query.address,
      chain: query.chain as Chain,
      network: query.network,
    });
    return ok({
      nonce: issue.nonce,
      issuedAt: issue.issuedAt,
      expiresAt: issue.expiresAt,
      domain: issue.domain,
      uri: issue.uri,
      statement: issue.statement,
      chainId: issue.chainId,
    });
  }

  // --------------------------------------------------------------------------
  // POST /auth/verify
  // --------------------------------------------------------------------------
  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify a SIWE signature and issue a JWT session.' })
  @ApiResponse({ type: VerifyResponseDto, status: 200 })
  async postVerify(
    @Body() body: VerifyRequestDto,
    @Res({ passthrough: true }) res: Response,
    @Headers(HEADER_REQUEST_ID) requestIdHeader?: string,
    @Headers(HEADER_USER_AGENT) userAgent?: string,
    @Ip() ip?: string,
  ): Promise<ApiSuccessResponse<VerifyResponseDto>> {
    const ctx = {
      requestId: requestIdHeader || undefined,
      ip,
      userAgent,
    };
    const result = await this.authService.verify({
      message: body.message,
      signature: body.signature,
      address: body.address,
      chain: body.chain as Chain,
      network: body.network,
      ...ctx,
    });
    // P1-003: also deliver the token in an HttpOnly cookie for browser
    // sessions. The body keeps `accessToken` for Bearer-mode backward
    // compatibility. Cookie Max-Age follows the configured JWT TTL (the SIWE
    // expirationTime may clamp the real exp shorter; an over-stated Max-Age
    // is harmless — the token itself enforces its own expiry).
    this.cookieAuth.setAuthCookie(res, result.token, parseDurationToSeconds(env().jwtExpiresIn));
    return ok({
      accessToken: result.token,
      user: {
        id: result.user.id,
        status: result.user.status,
        lastLoginAt: result.user.lastLoginAt?.toISOString() ?? null,
        wallets: result.user.wallets.map((w) => ({
          id: w.id,
          address: w.address,
          chain: w.chain,
          network: w.network,
          status: w.status,
          isPrimary: w.isPrimary,
        })),
      },
    });
  }

  // --------------------------------------------------------------------------
  // GET /auth/me — protected
  // --------------------------------------------------------------------------
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the current authenticated user + wallets.' })
  @ApiResponse({ type: MeResponseDto, status: 200 })
  async getMe(@AuthUser() auth?: AuthContext): Promise<ApiSuccessResponse<MeResponseDto['user']>> {
    if (!auth) throw new Error('guard did not attach auth');
    const user = await this.authService.getMe(auth.userId);
    return ok({
      id: user.id,
      status: user.status,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      wallets: user.wallets.map((w) => ({
        id: w.id,
        address: w.address,
        chain: w.chain,
        network: w.network,
        status: w.status,
        isPrimary: w.isPrimary,
      })),
    });
  }

  // --------------------------------------------------------------------------
  // POST /auth/logout — protected
  // --------------------------------------------------------------------------
  @Post('logout')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current JWT session immediately.' })
  async postLogout(
    @Res({ passthrough: true }) res: Response,
    @AuthUser() auth: AuthContext,
    @Headers(HEADER_REQUEST_ID) requestIdHeader?: string,
    @Headers(HEADER_USER_AGENT) userAgent?: string,
    @Ip() ip?: string,
  ): Promise<ApiSuccessResponse<{ loggedOut: boolean }>> {
    if (!auth) throw new Error('guard did not attach auth');
    await this.jwtAuth.revoke(auth.token);
    await this.audit.recordLogout({
      userId: auth.userId,
      requestId: requestIdHeader,
      ip,
      userAgent,
    });
    // P1-003: clear the access + CSRF cookies on logout (cookie session mode).
    // Bearer-only clients have no cookie set, so this is a no-op for them.
    this.cookieAuth.clearAuthCookies(res);
    return ok({ loggedOut: true });
  }
}

// Type helper (unused local; ensures Request type import for side effects).
export type _RequestTypeAlias = Request;
