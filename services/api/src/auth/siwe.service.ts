// ============================================================================
// SiweService — pure EIP-4361 A-BNF parser, formatter, and validator.
//
// Per P1-001/P1-002 memory lessons the sign/recover contract is fixed:
//   - CLIENT: personal_sign(rawMessage) via viem/wagmi (EIP-191 prefix added
//             by the wallet).
//   - SERVER: viem.verifyMessage({ message: rawMessage, signature }).
// We MUST NOT prepend the `\x19Ethereum Signed Message:\n<len>` prefix here;
// viem.verifyMessage handles it internally and a duplicate breaks recovery.
// ============================================================================

import { getAddress, isAddress, verifyMessage, type Hash } from 'viem';
import { AuthFailReason } from '@ai-wealth/shared';
import type { SiweMessage } from './siwe.message';

/** Thrown internally; the outer AuthService translates into AppError. */
export class SiweValidationError extends Error {
  constructor(
    public readonly reason: AuthFailReason,
    message: string,
  ) {
    super(message);
    this.name = 'SiweValidationError';
  }
}

/** Fields the service validates before handing control to the repository layer. */
export interface SiweWhitelist {
  domains: string[];
  uris: string[];
  /** Accepted chain ids (numeric). */
  chainIds: number[];
  /** Max issuedAt drift (seconds). Default 300. */
  clockSkewSec?: number;
}

/** EIP-4361 A-BNF regex. Permissive but rejects the obviously malformed. */
// eslint-disable-next-line max-len
const SIWE_REGEX =
  /^(?<domain>[^\n]+) wants you to sign in with your Ethereum account:\n(?<address>0x[a-fA-F0-9]{40})\n\n(?<statement>[^\n]*\n\n)?URI: (?<uri>[^\n]+)\nVersion: 1\nChain ID: (?<chainId>\d+)\nNonce: (?<nonce>[a-zA-Z0-9]{8,64})\nIssued At: (?<issuedAt>[^\n]+)\nExpiration Time: (?<expirationTime>[^\n]+)(?:\nNot Before: (?<notBefore>[^\n]+))?(?:\nRequest ID: (?<requestId>[^\n]+))?(?:\nResources:\n(?<resources>(?:- .+(?:\n|$))+))?$/s;

const RESOURCES_REGEX = /^- (.+)$/gm;

export class SiweService {
  /** Parse a raw EIP-4361 string into a SiweMessage. Throws SiweValidationError on malformed. */
  static parse(raw: string): SiweMessage {
    if (!raw || typeof raw !== 'string') {
      throw new SiweValidationError(
        AuthFailReason.MESSAGE_MALFORMED,
        'SIWE message must be a non-empty string',
      );
    }
    const match = SIWE_REGEX.exec(raw.trimEnd());
    if (!match || !match.groups) {
      throw new SiweValidationError(
        AuthFailReason.MESSAGE_MALFORMED,
        'SIWE message does not conform to EIP-4361 A-BNF',
      );
    }
    const g = match.groups as Record<string, string>;

    if (!isAddress(g.address)) {
      throw new SiweValidationError(AuthFailReason.BAD_ADDRESS, 'address is not EIP-55 valid');
    }

    const chainId = Number.parseInt(g.chainId, 10);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      throw new SiweValidationError(AuthFailReason.BAD_CHAIN_ID, 'chainId not a positive int');
    }

    const statement = g.statement ? g.statement.replace(/\n\n$/, '') : undefined;
    const resourcesBlock = g.resources;
    let resources: string[] | undefined;
    if (resourcesBlock) {
      resources = [];
      const copy = resourcesBlock;
      let m: RegExpExecArray | null;
      while ((m = RESOURCES_REGEX.exec(copy)) !== null) {
        resources.push(m[1]);
      }
    }

    return {
      domain: g.domain,
      address: getAddress(g.address),
      statement,
      uri: g.uri,
      chainId,
      nonce: g.nonce,
      issuedAt: g.issuedAt,
      expirationTime: g.expirationTime,
      notBefore: g.notBefore,
      requestId: g.requestId,
      resources,
    };
  }

  /** Canonical stringify. Mirrors the A-BNF order so parse(format(x)) round trips. */
  static format(msg: SiweMessage): string {
    const lines: string[] = [];
    lines.push(`${msg.domain} wants you to sign in with your Ethereum account:`);
    lines.push(msg.address);
    lines.push('');
    if (msg.statement) {
      lines.push(msg.statement);
      lines.push('');
    }
    lines.push(`URI: ${msg.uri}`);
    lines.push('Version: 1');
    lines.push(`Chain ID: ${msg.chainId}`);
    lines.push(`Nonce: ${msg.nonce}`);
    lines.push(`Issued At: ${msg.issuedAt}`);
    lines.push(`Expiration Time: ${msg.expirationTime}`);
    if (msg.notBefore) lines.push(`Not Before: ${msg.notBefore}`);
    if (msg.requestId) lines.push(`Request ID: ${msg.requestId}`);
    if (msg.resources && msg.resources.length > 0) {
      lines.push('Resources:');
      for (const r of msg.resources) lines.push(`- ${r}`);
    }
    return lines.join('\n');
  }

  /**
   * Validate a parsed SIWE message against the server whitelist and wall clock.
   * Does NOT perform signature recovery: use #verifySignature afterward.
   */
  static validateFields(msg: SiweMessage, whitelist: SiweWhitelist, now: Date = new Date()): void {
    // domain
    if (!whitelist.domains.includes(msg.domain)) {
      throw new SiweValidationError(AuthFailReason.BAD_DOMAIN, 'domain not in whitelist');
    }
    // uri
    if (!whitelist.uris.includes(msg.uri)) {
      throw new SiweValidationError(AuthFailReason.BAD_URI, 'uri not in whitelist');
    }
    // chain
    if (!whitelist.chainIds.includes(msg.chainId)) {
      throw new SiweValidationError(AuthFailReason.BAD_CHAIN_ID, 'chainId not in whitelist');
    }
    // issuedAt parse
    const issuedAt = new Date(msg.issuedAt);
    if (Number.isNaN(issuedAt.getTime())) {
      throw new SiweValidationError(AuthFailReason.BAD_ISSUED_AT, 'issuedAt not an ISO date');
    }
    const skewMs = (whitelist.clockSkewSec ?? 300) * 1000;
    if (issuedAt.getTime() - now.getTime() > skewMs) {
      throw new SiweValidationError(AuthFailReason.BAD_ISSUED_AT, 'issuedAt in the future');
    }
    // expirationTime
    const exp = new Date(msg.expirationTime);
    if (Number.isNaN(exp.getTime())) {
      throw new SiweValidationError(AuthFailReason.EXPIRED, 'expirationTime not an ISO date');
    }
    if (exp.getTime() <= now.getTime()) {
      throw new SiweValidationError(AuthFailReason.EXPIRED, 'message expired');
    }
    // nonce length — server nonces are always >= 16 chars; enforce it here.
    if (msg.nonce.length < 16) {
      throw new SiweValidationError(AuthFailReason.BAD_NONCE, 'nonce too short');
    }
    // notBefore
    if (msg.notBefore) {
      const nb = new Date(msg.notBefore);
      if (!Number.isNaN(nb.getTime()) && nb.getTime() > now.getTime()) {
        throw new SiweValidationError(AuthFailReason.BAD_ISSUED_AT, 'notBefore still in future');
      }
    }
  }

  /**
   * Verify signature using viem (no manual EIP-191 prefix per project lessons).
   * @throws SiweValidationError (BAD_SIGNATURE or BAD_ADDRESS mismatch)
   */
  static async verifySignature(params: {
    message: string;
    signature: `0x${string}` | Hash | string;
    expectedAddress: string;
  }): Promise<void> {
    if (!/^0x[a-fA-F0-9]+$/.test(String(params.signature))) {
      throw new SiweValidationError(AuthFailReason.BAD_SIGNATURE, 'signature hex required');
    }
    let valid: boolean;
    try {
      valid = (await verifyMessage({
        address: params.expectedAddress as `0x${string}`,
        message: params.message,
        signature: params.signature as `0x${string}`,
      })) as unknown as boolean;
    } catch (err) {
      throw new SiweValidationError(
        AuthFailReason.BAD_SIGNATURE,
        `verifyMessage threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!valid) {
      throw new SiweValidationError(AuthFailReason.BAD_SIGNATURE, 'signer != address claim');
    }
  }
}
