// ============================================================================
// AuthService — domain orchestrator (FR-2 main transaction).
//
// Flow:
//   1. Parse & validate SIWE message fields (domain/uri/chainId/issuedAt/exp).
//   2. Crypto verify signature → matches address claim.
//   3. Validate nonce + wallet identity match + unused + not expired.
//   4. Run transaction: consume nonce → get/create User → upsert Wallet
//      (status CONNECTED, bound) → upsert WalletIdentity SIWE → touch
//      users.last_login_at.
//   5. Commit → JWT sign + session register → return token + user+wallets.
//
// Controller stays thin. Repository writes ONLY happen inside the transaction.
// ============================================================================

import { Injectable } from '@nestjs/common';
import type { Chain, IdentityType, User, Wallet, WalletStatus } from '@ai-wealth/database';
import { ChainUtils, Repositories } from '@ai-wealth/database';
import { AppError, AppErrorCode, AuthFailReason, createLogger } from '@ai-wealth/shared';
import { env, SERVICE_NAMES } from '@ai-wealth/config';
import { AuditService } from './audit.service';
import { JwtAuthService } from './jwt-auth.service';
import { NonceService } from './nonce.service';
import { SiweService, SiweValidationError } from './siwe.service';
import type { SiweMessage } from './siwe.message';

export interface VerifyRequestInput {
  message: string;
  signature: string;
  address: string;
  chain: Chain;
  network: string;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export interface VerifySuccess {
  token: string;
  user: User & { wallets: Wallet[] };
  /**
   * P1-004 (additive): the walletId that was actually verified by THIS SIWE
   * login. Family issuance MUST use this value (never `user.wallets[0]` which
   * is order-dependent and could bind a refresh family to the wrong wallet
   * when the user owns multiple wallets).
   */
  verifiedWalletId: string;
  /**
   * P1-004 (additive): the SIWE authorization expiry (parsed.expirationTime).
   * The refresh-token family MUST NOT outlive this boundary; every access JWT
   * minted during refresh MUST be clamped to it as well.
   */
  authorizationExpiresAt: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = createLogger(SERVICE_NAMES.API);

  constructor(
    private readonly repos: Repositories,
    private readonly nonceService: NonceService,
    private readonly jwtAuth: JwtAuthService,
    private readonly audit: AuditService,
  ) {}

  async getMe(userId: string): Promise<User & { wallets: Wallet[] }> {
    const user = await this.repos.user.findById(userId, { includeWallets: true });
    if (!user) {
      throw AppError.unauthorized('Unauthorized', { reason: AuthFailReason.TOKEN_INVALID });
    }
    return user as User & { wallets: Wallet[] };
  }

  async verify(input: VerifyRequestInput): Promise<VerifySuccess> {
    const { message, signature, address, chain, network, requestId, ip, userAgent } = input;

    const fail = async (reason: AuthFailReason, msg = 'Unauthorized'): Promise<never> => {
      await this.audit.recordLoginFailure({
        reason,
        chain,
        address,
        requestId,
        ip,
        userAgent,
      });
      this.logger.warn('auth_verify_failed', {
        request_id: requestId,
        reason,
        chain,
        address_hash: AuditService.addressHash(address),
      });
      if (
        reason === AuthFailReason.WALLET_REVOKED ||
        reason === AuthFailReason.WALLET_DISCONNECTED
      ) {
        throw AppError.forbidden('Forbidden', { reason });
      }
      throw AppError.unauthorized(msg, { reason });
    };

    if (!ChainUtils.isSupportedForSiwe(chain)) {
      throw AppError.badRequest(`chain ${chain} not supported in P1-002`, {
        reason: AuthFailReason.CHAIN_UNSUPPORTED,
      });
    }

    // Step 1: parse SIWE
    let parsed: SiweMessage;
    try {
      parsed = SiweService.parse(message);
    } catch (err) {
      if (err instanceof SiweValidationError) return fail(err.reason);
      return fail(AuthFailReason.MESSAGE_MALFORMED);
    }

    // Step 2: address + chain must match request body
    if (parsed.address.toLowerCase() !== address.toLowerCase()) {
      return fail(AuthFailReason.BAD_ADDRESS);
    }
    const expectedChainId = ChainUtils.chainToChainId(chain);
    if (parsed.chainId !== expectedChainId) {
      return fail(AuthFailReason.BAD_CHAIN_ID);
    }

    // Step 3: validate whitelist fields (domain/uri/chainId/issuedAt/exp)
    const e = env();
    try {
      SiweService.validateFields(parsed, {
        domains: [e.siweDomain],
        uris: [e.siweUri],
        chainIds: [expectedChainId],
        clockSkewSec: e.siweClockSkewSec,
      });
    } catch (err) {
      if (err instanceof SiweValidationError) return fail(err.reason);
      return fail(AuthFailReason.MESSAGE_MALFORMED);
    }

    // Step 4: crypto signature recovery — NO manual EIP-191 prefix!
    try {
      await SiweService.verifySignature({
        message,
        signature: signature as `0x${string}`,
        expectedAddress: address,
      });
    } catch (err) {
      if (err instanceof SiweValidationError) return fail(err.reason);
      return fail(AuthFailReason.BAD_SIGNATURE);
    }

    // Step 5: validate nonce row exists, unused, not expired, matches wallet.
    let walletId: string;
    try {
      const res = await this.nonceService.validateForConsume({
        nonce: parsed.nonce,
        address,
        chain,
        network,
      });
      walletId = res.walletId;
    } catch (err) {
      const reason = (err instanceof AppError && err.reason) || AuthFailReason.BAD_NONCE;
      return fail(reason as AuthFailReason);
    }

    // Step 6: transactional writes: consume nonce, user/wallet bind, identity, last_login.
    let result: VerifySuccess | null = null;
    try {
      result = await this.repos.transaction(async (repos) => {
        const consumed = await repos.authNonce.consume(parsed.nonce);
        if (!consumed.ok || !consumed.nonce) {
          throw AppError.conflict('nonce already consumed', {
            reason: AuthFailReason.NONCE_USED,
          });
        }
        let wallet = await repos.wallet.findById(walletId);
        if (!wallet) {
          throw AppError.internal('wallet missing for nonce');
        }
        if (wallet.status === 'REVOKED') {
          throw AppError.forbidden('wallet revoked', { reason: AuthFailReason.WALLET_REVOKED });
        }

        let user: User;
        if (wallet.userId) {
          const existing = await repos.user.findById(wallet.userId);
          if (!existing) {
            throw AppError.internal('wallet user missing');
          }
          user = existing;
          // Ensure CONNECTED status on verified wallets.
          if (wallet.status !== 'CONNECTED') {
            wallet = await repos.wallet.update(wallet.id, { status: 'CONNECTED' });
          }
        } else {
          user = await repos.user.create();
          wallet = await repos.wallet.bindUser(wallet.id, user.id, 'CONNECTED' as WalletStatus);
        }

        // WalletIdentity upsert: one SIWE proof per wallet. Create when absent.
        const identityType: IdentityType = 'SIWE';
        const existingIdentity = await repos.walletIdentity.findUnique(wallet.id, identityType);
        if (!existingIdentity) {
          await repos.walletIdentity.create({ walletId: wallet.id, identityType });
        }

        const updatedUser = await repos.user.touchLastLogin(user.id);
        const wallets = await repos.wallet.listByUser(updatedUser.id);
        const { token } = await this.jwtAuth.sign({
          userId: updatedUser.id,
          walletId: wallet.id,
          absoluteExpiresAtIso: parsed.expirationTime,
        });
        return {
          token,
          user: { ...updatedUser, wallets },
          // P1-004 (additive): the walletId that was actually verified by this
          // SIWE login — used by issueFamily to bind the refresh family to the
          // correct wallet when the user owns multiple wallets.
          verifiedWalletId: wallet.id,
          // P1-004 (additive): the SIWE authorization expiry. The refresh-token
          // family MUST NOT outlive this boundary (familyExpiresAt =
          // min(now + 30d, authorizationExpiresAt)); every access JWT minted
          // during refresh MUST be clamped to it as well.
          authorizationExpiresAt: parsed.expirationTime ?? null,
        };
      });
    } catch (err) {
      if (err instanceof AppError) {
        const reason = (err.reason as AuthFailReason) || AuthFailReason.BAD_SIGNATURE;
        if (err.code === AppErrorCode.CONFLICT) {
          return fail(AuthFailReason.NONCE_USED);
        }
        return fail(reason);
      }
      this.logger.error('auth_verify_tx_error', {
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      return fail(AuthFailReason.BAD_SIGNATURE, 'Unauthorized');
    }

    await this.audit.recordLoginSuccess({
      userId: result.user.id,
      walletId,
      chain,
      address,
      requestId,
      ip,
      userAgent,
    });
    return result;
  }
}
