// ============================================================================
// AuthController — auth endpoints under /auth (/api prefix via global config).
//
// P1-002: nonce / verify / me / logout (SIWE + JWT).
// P1-003: cookie session + DSC CSRF + Bearer/Cookie dual-mode guard.
// P1-004: refresh token rotation + token family + reuse detection.
//   - verify additionally issues the FIRST refresh token (new family).
//   - /refresh rotates the refresh token (atomic Lua) and mints a new access
//     JWT via jwtAuth.sign() — JwtAuthService internals are unchanged.
//   - logout uses LogoutGuard (access OR refresh), clears ALL THREE cookies
//     first (constraint B), then revokes + responds by credential validity.
//   - Transport mode (X-Auth-Transport) is enforced by TransportMiddleware
//     before this controller runs; req.authTransport / req.isBrowserOrigin are
//     available. In cookie mode the body NEVER carries tokens.
//
// All endpoints return the unified ApiResponse envelope { success, data }.
// ============================================================================

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  Headers,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { Chain } from '@ai-wealth/database';
import { AppError, AuthFailReason, ok } from '@ai-wealth/shared';
import type { ApiSuccessResponse } from '@ai-wealth/shared';
import { AuthService } from './auth.service';
import { AuditService } from './audit.service';
import { JwtAuthService } from './jwt-auth.service';
import { AuthContext, AuthUser, JwtAuthGuard } from './jwt-auth.guard';
import { CookieAuthService } from './cookie-auth.service';
import { CsrfService } from './csrf.service';
import { RefreshTokenService } from './refresh-token.service';
import { NonceService } from './nonce.service';
import { TransportMiddleware, type TransportRequest } from './transport.middleware';
import { LogoutGuard, type LogoutRequest } from './logout.guard';
import { NonceQueryDto, NonceResponseDto } from './dto/nonce-query.dto';
import { MeResponseDto, VerifyRequestDto, VerifyResponseDto } from './dto/verify-request.dto';
import { RefreshRequestDto, RefreshResponseDto } from './dto/refresh-request.dto';
import { CsrfTokenResponseDto } from './dto/csrf-token.dto';

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
    private readonly refreshTokens: RefreshTokenService,
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
  // POST /auth/verify — SIWE verify + issue access JWT + first refresh token.
  // P1-004: transport mode splits the response — cookie mode sets HttpOnly
  // cookies and returns ONLY {user}; api mode returns tokens in the body.
  // --------------------------------------------------------------------------
  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify a SIWE signature and issue access + refresh tokens.' })
  @ApiResponse({ type: VerifyResponseDto, status: 200 })
  async postVerify(
    @Body() body: VerifyRequestDto,
    @Req() req: TransportRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers(HEADER_REQUEST_ID) requestIdHeader?: string,
    @Headers(HEADER_USER_AGENT) userAgent?: string,
    @Ip() ip?: string,
  ): Promise<ApiSuccessResponse<VerifyResponseDto>> {
    const ctx = { requestId: requestIdHeader || undefined, ip, userAgent };
    const result = await this.authService.verify({
      message: body.message,
      signature: body.signature,
      address: body.address,
      chain: body.chain as Chain,
      network: body.network,
      ...ctx,
    });

    // P1-004: issue the first refresh token (new family) after a successful
    // SIWE login. This happens OUTSIDE the DB transaction (Redis write) so a
    // Redis hiccup does not roll back the login; if it fails the user still
    // has a valid access JWT for the short access lifetime and can re-login.
    const { refreshToken, familyExpiresAt } = await this.refreshTokens.issueFamily({
      userId: result.user.id,
      walletId: result.user.wallets[0]?.id ?? '',
    });

    const transport = req.authTransport ?? 'legacy';
    if (transport === 'cookie') {
      // Cookie mode: set both HttpOnly cookies; body carries ONLY {user}.
      this.cookieAuth.setAuthCookie(res, result.token);
      this.cookieAuth.setRefreshCookie(res, refreshToken, familyExpiresAt);
      return ok({
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
      } satisfies VerifyResponseDto);
    }
    if (transport === 'api') {
      // api mode: return tokens in body; no cookies set.
      return ok({
        accessToken: result.token,
        refreshToken,
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
      } satisfies VerifyResponseDto);
    }
    // legacy mode (no X-Auth-Transport header): P1-003 dual-mode compatibility —
    // set the access + refresh cookies AND return the tokens in the body. This
    // keeps pre-P1-004 clients (and the unchanged T01-T15 / C01-C11 regression
    // suites) working without declaring a transport. C02 asserts a cookie is
    // set; C04 asserts a body token is present — dual mode satisfies both.
    this.cookieAuth.setAuthCookie(res, result.token);
    this.cookieAuth.setRefreshCookie(res, refreshToken, familyExpiresAt);
    return ok({
      accessToken: result.token,
      refreshToken,
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
    } satisfies VerifyResponseDto);
  }

  // --------------------------------------------------------------------------
  // POST /auth/refresh — rotate refresh token + mint new access JWT.
  // Cookie mode: refresh from cookie, CSRF enforced (TransportMiddleware +
  // CsrfGuard), body carries NO token, response sets new cookies + {user}.
  // api mode: refresh from body, CSRF exempt, response carries new tokens.
  // --------------------------------------------------------------------------
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access JWT.' })
  @ApiResponse({ type: RefreshResponseDto, status: 200 })
  async postRefresh(
    @Body() body: RefreshRequestDto,
    @Req() req: TransportRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers(HEADER_REQUEST_ID) requestIdHeader?: string,
    @Headers(HEADER_USER_AGENT) userAgent?: string,
    @Ip() ip?: string,
  ): Promise<ApiSuccessResponse<RefreshResponseDto>> {
    const ctx = { requestId: requestIdHeader || undefined, ip, userAgent };
    const transport = req.authTransport ?? 'api';

    // Resolve the presented refresh token: cookie (cookie mode) > body (api).
    // Cookie-priority: if cookie present AND body also present, ignore body.
    const cookieToken = this.cookieAuth.readRefreshCookie(req);
    const bodyToken = body.refreshToken;
    let token: string;
    if (transport === 'cookie') {
      if (!cookieToken) {
        // cookie mode declared but no refresh cookie → invalid.
        throw AppError.unauthorized('Refresh token invalid', {
          reason: AuthFailReason.REFRESH_TOKEN_INVALID,
        });
      }
      if (bodyToken) {
        // Body ignored in cookie mode; audit for observability.
        await this.audit.recordRefreshBodyIgnored({ ...ctx });
      }
      token = cookieToken;
    } else {
      token = bodyToken ?? '';
      if (!token) {
        throw AppError.unauthorized('Refresh token invalid', {
          reason: AuthFailReason.REFRESH_TOKEN_INVALID,
        });
      }
    }

    // Atomic rotation (Lua): rotated | retry | reused | revoked | invalid.
    const outcome = await this.refreshTokens.rotate(token);

    if (outcome.kind === 'invalid') {
      await this.audit.recordRefreshFailure({
        reason: AuthFailReason.REFRESH_TOKEN_INVALID,
        ...ctx,
      });
      throw AppError.unauthorized('Refresh token invalid', {
        reason: AuthFailReason.REFRESH_TOKEN_INVALID,
      });
    }
    if (outcome.kind === 'retry') {
      // Network retry window — do NOT return a token (we don't store plaintext).
      // Clear the refresh cookie in cookie mode so the client re-authenticates.
      if (transport === 'cookie') {
        this.cookieAuth.clearAuthCookies(res);
      }
      throw AppError.conflict('Refresh token recently used; retry with current token', {
        reason: AuthFailReason.REFRESH_RETRY,
      });
    }
    if (outcome.kind === 'reused') {
      // Reuse detected — family was revoked atomically inside the Lua script.
      const fam = outcome.familyId
        ? await this.refreshTokens.getFamilyMeta(outcome.familyId)
        : null;
      await this.audit.recordRefreshReuse({
        userId: fam?.userId ?? null,
        familyId: outcome.familyId || 'unknown',
        tokenHashPrefix: this.refreshTokens.hashToken(token).slice(0, 8),
        ...ctx,
      });
      if (transport === 'cookie') {
        this.cookieAuth.clearAuthCookies(res);
      }
      throw AppError.forbidden('Refresh token reuse detected', {
        reason: AuthFailReason.REFRESH_TOKEN_REUSED,
      });
    }
    if (outcome.kind === 'revoked') {
      if (transport === 'cookie') {
        this.cookieAuth.clearAuthCookies(res);
      }
      throw AppError.forbidden('Refresh family revoked', {
        reason: AuthFailReason.REFRESH_TOKEN_REVOKED,
      });
    }

    // outcome.kind === 'rotated' — mint a new access JWT.
    const fam = await this.refreshTokens.getFamilyMeta(outcome.familyId);
    const userId = fam?.userId;
    if (!userId) {
      // Family vanished between rotate and read — treat as invalid.
      throw AppError.unauthorized('Refresh token invalid', {
        reason: AuthFailReason.REFRESH_TOKEN_INVALID,
      });
    }
    const { token: accessToken, payload } = await this.jwtAuth.sign({
      userId,
      walletId: fam?.walletId,
    });

    await this.audit.recordRefreshSuccess({ userId, familyId: outcome.familyId, ...ctx });

    const user = await this.authService.getMe(userId);

    if (transport === 'cookie') {
      // Set new access + refresh cookies; body carries ONLY {user}.
      this.cookieAuth.setAuthCookie(res, accessToken);
      const familyExpiresAt = fam?.familyExpiresAt ?? Math.floor(Date.now() / 1000);
      this.cookieAuth.setRefreshCookie(res, outcome.newRefreshToken, familyExpiresAt);
      return ok({
        user: {
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
        },
      } satisfies RefreshResponseDto);
    }
    // api mode: return tokens in body.
    void payload;
    return ok({
      accessToken,
      refreshToken: outcome.newRefreshToken,
      user: {
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
      },
    } satisfies RefreshResponseDto);
  }

  // --------------------------------------------------------------------------
  // GET /auth/me — protected (P1-002, unchanged).
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
  // POST /auth/logout — P1-004: LogoutGuard (access OR refresh); clear cookies
  // FIRST (constraint B), then revoke + respond by credential validity.
  // --------------------------------------------------------------------------
  @Post('logout')
  @HttpCode(200)
  @UseGuards(LogoutGuard)
  @ApiOperation({ summary: 'Revoke the access JWT and/or refresh family; clear cookies.' })
  async postLogout(
    @Req() req: LogoutRequest & TransportRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers(HEADER_REQUEST_ID) requestIdHeader?: string,
    @Headers(HEADER_USER_AGENT) userAgent?: string,
    @Ip() ip?: string,
  ): Promise<ApiSuccessResponse<{ loggedOut: boolean }>> {
    const ctx = { requestId: requestIdHeader || undefined, ip, userAgent };
    const transport = req.authTransport ?? 'legacy';
    const creds = req.logoutCredentials;

    // Constraint B: in cookie mode AND legacy (P1-003 compat) mode, ALWAYS
    // clear the three cookies first, even if both credentials are invalid.
    // LogoutGuard did not throw — the controller runs, clears cookies, then
    // decides the response code. Legacy mode matches P1-003 (always cleared).
    if (transport === 'cookie' || transport === 'legacy') {
      this.cookieAuth.clearAuthCookies(res);
    }

    const accessValid = creds?.access?.valid === true;
    const refreshValid = creds?.refresh?.valid === true;

    if (!accessValid && !refreshValid) {
      // Cookies already cleared (cookie/legacy mode). api mode has nothing to
      // clear. Return 401 so the client knows to re-authenticate.
      throw AppError.unauthorized('No valid credentials', {
        reason: AuthFailReason.NOT_AUTHENTICATED,
      });
    }

    // Revoke whatever is valid.
    if (accessValid && creds?.access?.token) {
      await this.jwtAuth.revoke(creds.access.token);
    }
    if (refreshValid && creds?.refresh?.familyId) {
      await this.refreshTokens.revokeFamily(creds.refresh.familyId, 'LOGOUT');
    }

    const userId = creds?.access?.userId ?? creds?.refresh?.userId ?? 'unknown';
    // AUTH_LOGOUT audit — preserves the P1-002 T13 assertion (unchanged) which
    // checks for an AUTH_LOGOUT row. recordLogout is an existing P1-002 method
    // (additive audit policy: existing methods untouched).
    await this.audit.recordLogout({ userId, ...ctx });
    // P1-004: additionally record the family revocation when a refresh family
    // was revoked (new additive audit action AUTH_SESSION_REVOKED).
    if (refreshValid && creds?.refresh?.familyId) {
      await this.audit.recordSessionRevoked({
        userId,
        familyId: creds.refresh.familyId,
        ...ctx,
      });
    }

    return ok({ loggedOut: true });
  }
}

// Type helpers (unused locals; keep imports referenced for side effects).
export type _TransportMiddlewareType = typeof TransportMiddleware;
export type _LogoutRequestType = LogoutRequest;
