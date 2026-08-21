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

/**
 * EIP-4361 prefix / header literals. Kept as constants so the line-based
 * parser does O(1) prefix matches per line (deterministic, zero backtracking,
 * no catastrophic-redos risk — passes CodeQL inefficient-regex rule).
 */
const HEADER_SUFFIX = ' wants you to sign in with your Ethereum account:';
const PREFIX_URI = 'URI: ';
const PREFIX_VERSION = 'Version: ';
const PREFIX_CHAIN_ID = 'Chain ID: ';
const PREFIX_NONCE = 'Nonce: ';
const PREFIX_ISSUED_AT = 'Issued At: ';
const PREFIX_EXPIRATION_TIME = 'Expiration Time: ';
const PREFIX_NOT_BEFORE = 'Not Before: ';
const PREFIX_REQUEST_ID = 'Request ID: ';
const PREFIX_RESOURCES = 'Resources:';
const PREFIX_RESOURCE_ITEM = '- ';
const EXPECTED_VERSION = '1';

/** Small bounded helper regex for hex-address shape (constant cost, no alternation nesting). */
const ADDRESS_SHAPE = /^0x[a-fA-F0-9]{40}$/;
/** Nonce charset + length check (bounded quantifier, no nesting). */
const NONCE_SHAPE = /^[a-zA-Z0-9]{8,64}$/;
/** Chain id: digits only, bounded length (<= well above realistic chain id widths). */
const CHAIN_ID_SHAPE = /^\d{1,10}$/;

function malformed(detail: string): SiweValidationError {
  return new SiweValidationError(AuthFailReason.MESSAGE_MALFORMED, detail);
}

export class SiweService {
  /**
   * Parse a raw EIP-4361 string into a SiweMessage. Throws SiweValidationError
   * on malformed input.
   *
   * Implementation: strict LINE-BY-LINE state machine following the A-BNF
   * order. State transitions are deterministic; each labeled line is matched
   * via startsWith() — no mega-regex, no catastrophic-backtracking surface.
   */
  static parse(raw: string): SiweMessage {
    if (!raw || typeof raw !== 'string') {
      throw malformed('SIWE message must be a non-empty string');
    }
    // Trim TRAILING whitespace only (EIP-4361 allows no leading noise).
    // We strip trailing CR/LF/tabs/spaces by hand to avoid eslint's
    // no-control-regex rule (which would flag a \u0000 class). Order: first
    // native trimEnd() (whitespace), then strip any remaining CR chars that
    // some legacy clients may append. This is O(n) and regex-free for the
    // control-char portion.
    let trimmed = raw.trimEnd();
    while (trimmed.length > 0 && trimmed.charCodeAt(trimmed.length - 1) === 0x0d) {
      trimmed = trimmed.slice(0, -1);
    }
    if (trimmed.length === 0) throw malformed('SIWE message is empty after trim');

    // Split strictly on '\n'. EIP-4361 specifies LF, not CRLF. Tolerate a
    // trailing '\r' (CR, 0x0d) on each line via charCode check — regex-free
    // so we pass eslint no-control-regex (CodeQL friendly too).
    function stripTrailingCR(s: string): string {
      if (s.length > 0 && s.charCodeAt(s.length - 1) === 0x0d) {
        return s.slice(0, -1);
      }
      return s;
    }
    const rawLines = trimmed.split('\n');
    const lines = rawLines.map(stripTrailingCR);
    let i = 0;
    const peek = (): string | undefined => lines[i];
    const consume = (): string => lines[i++]!;
    const eof = (): boolean => i >= lines.length;

    // --- Line 0: <domain> wants you to sign in with your Ethereum account: --
    if (eof()) throw malformed('missing header line');
    const header = consume();
    if (!header.endsWith(HEADER_SUFFIX) || header.length <= HEADER_SUFFIX.length) {
      throw malformed(`bad header: expected "<domain>${HEADER_SUFFIX}"`);
    }
    const domain = header.slice(0, header.length - HEADER_SUFFIX.length);
    if (domain.length === 0 || domain.includes('\n')) throw malformed('bad domain');

    // --- Line 1: address ---------------------------------------------------
    if (eof()) throw malformed('missing address line');
    const addressRaw = consume();
    if (!ADDRESS_SHAPE.test(addressRaw)) {
      throw malformed('address must be 0x followed by 40 hex chars');
    }
    if (!isAddress(addressRaw)) {
      throw new SiweValidationError(AuthFailReason.BAD_ADDRESS, 'address is not EIP-55 valid');
    }
    const address = getAddress(addressRaw as `0x${string}`);

    // --- Line 2: blank -----------------------------------------------------
    if (eof() || consume() !== '') throw malformed('missing blank line after address');

    // --- Optional statement + blank ---------------------------------------
    // Statement line: single non-empty line that does NOT start with any
    // reserved labeled prefix (so malformed "URI: foo" cannot masquerade as
    // statement). Followed by another mandatory blank.
    let statement: string | undefined;
    const next1 = peek();
    if (next1 !== undefined) {
      const next2 = lines[i + 1];
      if (
        next1 !== '' &&
        next2 === '' &&
        !next1.startsWith(PREFIX_URI) &&
        !next1.startsWith(PREFIX_VERSION) &&
        !next1.startsWith(PREFIX_CHAIN_ID) &&
        !next1.startsWith(PREFIX_NONCE) &&
        !next1.startsWith(PREFIX_ISSUED_AT) &&
        !next1.startsWith(PREFIX_EXPIRATION_TIME) &&
        !next1.startsWith(PREFIX_NOT_BEFORE) &&
        !next1.startsWith(PREFIX_REQUEST_ID) &&
        !next1.startsWith(PREFIX_RESOURCES) &&
        !next1.startsWith(PREFIX_RESOURCE_ITEM)
      ) {
        statement = consume(); // statement
        if (consume() !== '') throw malformed('missing blank line after statement');
      } else if (next1 === '') {
        consume(); // mandatory blank before labeled fields
      }
      // else: next1 is a labeled line without a preceding blank -> will be
      // caught by the required URI label check below (state machine will
      // simply fail the prefix match).
    }

    // --- Required labeled lines in exact order ----------------------------
    const takePrefixed = (prefix: string, label: string): string => {
      if (eof()) throw malformed(`missing ${label} line`);
      const line = consume();
      if (!line.startsWith(prefix))
        throw malformed(`bad ${label} line: missing prefix "${prefix}"`);
      const value = line.slice(prefix.length);
      if (value.length === 0) throw malformed(`${label} has empty value`);
      return value;
    };

    const uri = takePrefixed(PREFIX_URI, 'URI');
    const version = takePrefixed(PREFIX_VERSION, 'Version');
    if (version !== EXPECTED_VERSION) throw malformed(`Version must be ${EXPECTED_VERSION}`);

    const chainIdRaw = takePrefixed(PREFIX_CHAIN_ID, 'Chain ID');
    if (!CHAIN_ID_SHAPE.test(chainIdRaw)) throw malformed('Chain ID must be 1-10 digits');
    const chainId = Number.parseInt(chainIdRaw, 10);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      throw new SiweValidationError(AuthFailReason.BAD_CHAIN_ID, 'chainId not a positive int');
    }

    const nonce = takePrefixed(PREFIX_NONCE, 'Nonce');
    if (!NONCE_SHAPE.test(nonce)) {
      throw new SiweValidationError(
        AuthFailReason.BAD_NONCE,
        'nonce must be 8-64 alphanumeric chars',
      );
    }

    const issuedAt = takePrefixed(PREFIX_ISSUED_AT, 'Issued At');
    const expirationTime = takePrefixed(PREFIX_EXPIRATION_TIME, 'Expiration Time');

    // --- Optional labeled lines in exact order (Not Before, Request ID) ---
    let notBefore: string | undefined;
    if (!eof() && peek()!.startsWith(PREFIX_NOT_BEFORE)) {
      notBefore = consume().slice(PREFIX_NOT_BEFORE.length);
      if (notBefore.length === 0) throw malformed('Not Before has empty value');
    }

    let requestId: string | undefined;
    if (!eof() && peek()!.startsWith(PREFIX_REQUEST_ID)) {
      requestId = consume().slice(PREFIX_REQUEST_ID.length);
      if (requestId.length === 0) throw malformed('Request ID has empty value');
    }

    // --- Optional Resources block -----------------------------------------
    let resources: string[] | undefined;
    if (!eof()) {
      const resourcesHeader = consume();
      if (resourcesHeader !== PREFIX_RESOURCES) {
        throw malformed(`unexpected trailing content: "${resourcesHeader}"`);
      }
      if (eof()) throw malformed('Resources header present but no items follow');
      resources = [];
      while (!eof()) {
        const line = consume();
        if (!line.startsWith(PREFIX_RESOURCE_ITEM)) {
          throw malformed(`Resources item must start with "${PREFIX_RESOURCE_ITEM}"`);
        }
        const item = line.slice(PREFIX_RESOURCE_ITEM.length);
        if (item.length === 0) throw malformed('Resources item has empty value');
        resources.push(item);
      }
    }

    return {
      domain,
      address,
      statement,
      uri,
      chainId,
      nonce,
      issuedAt,
      expirationTime,
      notBefore,
      requestId,
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
