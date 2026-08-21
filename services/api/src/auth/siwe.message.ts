// ============================================================================
// SiweMessage — EIP-4361 A-BNF structured representation.
// SiweService.parse() consumes the raw sign-in string and returns one of
// these; SiweService.format() produces a canonical string from one of these.
//
// Strict A-BNF (per EIP-4361) — every field except `notBefore`, `requestId`,
// and `resources` is mandatory.
// ============================================================================

export interface SiweResources {
  /** Optional list of URIs the user-agrees to be bound by. */
  resources?: string[];
}

export interface SiweMessage extends SiweResources {
  /** RFC 3986 authority that asks for the signature (e.g. "localhost:3000"). */
  domain: string;
  /** The address performing the signing (checksummed). */
  address: string;
  /** Optional human-readable ASCII assertion the user signs. */
  statement?: string;
  /** RFC 3986 URI referring to the resource subject of the signing. */
  uri: string;
  /** EIP-155 Chain ID. */
  chainId: number;
  /** Randomized token to mitigate replay attacks (server-issued). */
  nonce: string;
  /** ISO 8601 datetime string of when the message was generated. */
  issuedAt: string;
  /** ISO 8601 datetime string — when the signed message becomes invalid. */
  expirationTime: string;
  /** ISO 8601 datetime string (optional) — when the message becomes valid. */
  notBefore?: string;
  /** Opaque string the server may use (optional). */
  requestId?: string;
}
