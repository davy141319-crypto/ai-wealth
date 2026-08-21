// ============================================================================
// NonceService — server-issued SIWE challenges.
//
// Responsibilities (FR-1 / FR-6):
//   - Generate cryptographically-random nonce (32 bytes, base16 → 64 chars).
//   - Ensure Wallet row exists for the address (status=DISCONNECTED on first
//     issue; verify promotes to CONNECTED + binds to User).
//   - Create AuthNonce row bound to the wallet. Expiry set by
//     `siweNonceTtlSec`.
//   - Validate a nonce before consumption: exists, not used, not expired,
//     wallet matches (address/chain/network).
//
// Repository stays dumb: crypto is generated HERE so tests can inject a
// deterministic override.
// ============================================================================

import { Injectable } from '@nestjs/common';
import type { Chain, WalletStatus } from '@ai-wealth/database';
import { randomBytes } from 'node:crypto';
import { ChainUtils, Repositories } from '@ai-wealth/database';
import { AppError, AuthFailReason } from '@ai-wealth/shared';
import { env } from '@ai-wealth/config';

export interface IssueResult {
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  walletId: string;
  domain: string;
  uri: string;
  statement: string;
  chainId: number;
}

@Injectable()
export class NonceService {
  /** Override for deterministic tests. Default crypto.randomBytes(32).hex. */
  public nonceGenerator: (size?: number) => string = (size = 32) =>
    randomBytes(size).toString('hex');

  constructor(private readonly repos: Repositories = new Repositories()) {}

  /**
   * Issue a fresh nonce for the given wallet identity.
   * TRON: unsupported in P1-002 — throws BAD_REQUEST CHAIN_UNSUPPORTED.
   */
  async issue(params: { address: string; chain: Chain; network: string }): Promise<IssueResult> {
    const { address, chain, network } = params;
    if (!ChainUtils.isEvmAddress(address)) {
      throw AppError.validation('address must be a 0x-prefixed EVM address');
    }
    if (!ChainUtils.isSupportedForSiwe(chain)) {
      throw AppError.badRequest(`chain ${chain} not supported in P1-002`, {
        reason: AuthFailReason.CHAIN_UNSUPPORTED,
      });
    }
    const chainId = ChainUtils.chainToChainId(chain);
    const ttl = env().siweNonceTtlSec;
    const nonce = this.nonceGenerator(32);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);

    // Idempotently create wallet row in DISCONNECTED state if none exists.
    let wallet = await this.repos.wallet.findUnique({ address, chain, network });
    if (!wallet) {
      wallet = await this.repos.wallet.create({
        address,
        chain,
        network,
        status: 'DISCONNECTED' as WalletStatus,
      });
    }
    await this.repos.authNonce.create({ walletId: wallet.id, nonce, expiresAt });
    const e = env();
    return {
      nonce,
      issuedAt,
      expiresAt,
      walletId: wallet.id,
      domain: e.siweDomain,
      uri: e.siweUri,
      statement: e.siweStatement,
      chainId,
    };
  }

  /**
   * Look up a nonce row together with its wallet and ensure it matches the
   * supplied identity. Returns the nonce + wallet or throws.
   */
  async validateForConsume(params: {
    nonce: string;
    address: string;
    chain: Chain;
    network: string;
    now?: Date;
  }): Promise<{ nonceId: string; walletId: string }> {
    const { nonce, address, chain, network, now = new Date() } = params;
    const row = await this.repos.authNonce.findByNonce(nonce);
    if (!row) {
      throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized', {
        reason: AuthFailReason.BAD_NONCE,
      });
    }
    const wallet = await this.repos.wallet.findById(row.walletId);
    if (!wallet) {
      throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized', {
        reason: AuthFailReason.BAD_NONCE,
      });
    }
    if (
      wallet.address.toLowerCase() !== address.toLowerCase() ||
      wallet.chain !== chain ||
      wallet.network !== network
    ) {
      throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized', {
        reason: AuthFailReason.BAD_NONCE,
      });
    }
    if (row.usedAt) {
      throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized', {
        reason: AuthFailReason.NONCE_USED,
      });
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized', {
        reason: AuthFailReason.EXPIRED,
      });
    }
    return { nonceId: row.id, walletId: wallet.id };
  }
}
