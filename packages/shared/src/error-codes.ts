/**
 * Unified application error codes.
 * All business/infra errors map to one of these stable codes so that
 * clients can switch on `error.code` reliably across releases.
 */
export enum AppErrorCode {
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  BAD_REQUEST = 'BAD_REQUEST',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  DEPENDENCY_DOWN = 'DEPENDENCY_DOWN',
}

/**
 * Stable auth-specific failure reasons. Values are surfaced into
 * AuditLog.metadata.reasonCode — never into HTTP responses.
 * Keep values immutable across releases: renames break historical audit
 * queries.
 */
export enum AuthFailReason {
  BAD_SIGNATURE = 'AUTH_BAD_SIGNATURE',
  BAD_ADDRESS = 'AUTH_BAD_ADDRESS',
  BAD_DOMAIN = 'AUTH_BAD_DOMAIN',
  BAD_URI = 'AUTH_BAD_URI',
  BAD_CHAIN_ID = 'AUTH_BAD_CHAIN_ID',
  BAD_NONCE = 'AUTH_BAD_NONCE',
  NONCE_USED = 'AUTH_NONCE_USED',
  EXPIRED = 'AUTH_EXPIRED',
  BAD_ISSUED_AT = 'AUTH_BAD_ISSUED_AT',
  WALLET_REVOKED = 'AUTH_WALLET_REVOKED',
  WALLET_DISCONNECTED = 'AUTH_WALLET_DISCONNECTED',
  CHAIN_UNSUPPORTED = 'AUTH_CHAIN_UNSUPPORTED',
  MESSAGE_MALFORMED = 'AUTH_MESSAGE_MALFORMED',
  TOKEN_INVALID = 'AUTH_TOKEN_INVALID',
  TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED',
  TOKEN_REVOKED = 'AUTH_TOKEN_REVOKED',
  NOT_AUTHENTICATED = 'AUTH_NOT_AUTHENTICATED',
  CSRF_TOKEN_INVALID = 'AUTH_CSRF_TOKEN_INVALID',
  // P1-004 — refresh-token rotation + reuse detection. EXPIRED is intentionally
  // absent: once a Redis key TTL elapses the lookup/family/used keys vanish, so
  // the server CANNOT distinguish an expired token from a forged one. Both
  // surface as REFRESH_TOKEN_INVALID and the client must re-authenticate.
  REFRESH_TOKEN_INVALID = 'AUTH_REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_REUSED = 'AUTH_REFRESH_TOKEN_REUSED',
  REFRESH_TOKEN_REVOKED = 'AUTH_REFRESH_TOKEN_REVOKED',
  REFRESH_RETRY = 'AUTH_REFRESH_RETRY',
  // P1-004 — explicit transport mode (`X-Auth-Transport`) + Origin allowlist.
  TRANSPORT_REQUIRED = 'AUTH_TRANSPORT_REQUIRED',
  TRANSPORT_ORIGIN_CONFLICT = 'AUTH_TRANSPORT_ORIGIN_CONFLICT',
  TRANSPORT_COOKIE_CONFLICT = 'AUTH_TRANSPORT_COOKIE_CONFLICT',
  ORIGIN_NOT_ALLOWED = 'AUTH_ORIGIN_NOT_ALLOWED',
}

/**
 * P1-006 — Backend RBAC authorization failure reasons.
 *
 * These are surfaced into AuditLog.metadata.reasonCode (never into HTTP
 * responses — clients only see the generic FORBIDDEN/INTERNAL_ERROR envelope).
 * Keep values immutable across releases: renames break historical audit
 * queries.
 *
 * Distinction from AuthFailReason: AuthFailReason is about AUTHENTICATION
 * (who are you?); AuthzFailReason is about AUTHORIZATION (are you allowed to?).
 *
 * `AUTHZ_ROLE_LOOKUP_FAILED` is the ONE reason that maps to 5xx (infrastructure
 * failure, not a permission denial) — every other value maps to 403.
 */
export enum AuthzFailReason {
  AUTHZ_NO_AUTH_CONTEXT = 'AUTHZ_NO_AUTH_CONTEXT',
  AUTHZ_ROLE_METADATA_MISSING = 'AUTHZ_ROLE_METADATA_MISSING',
  AUTHZ_USER_NOT_FOUND = 'AUTHZ_USER_NOT_FOUND',
  AUTHZ_USER_INACTIVE = 'AUTHZ_USER_INACTIVE',
  AUTHZ_ROLE_INSUFFICIENT = 'AUTHZ_ROLE_INSUFFICIENT',
  AUTHZ_ROLE_LOOKUP_FAILED = 'AUTHZ_ROLE_LOOKUP_FAILED',
}

/** AuditLog action names. Stable values; never rename. */
export enum AuditAction {
  AUTH_LOGIN_SUCCESS = 'AUTH_LOGIN_SUCCESS',
  AUTH_LOGIN_FAILURE = 'AUTH_LOGIN_FAILURE',
  AUTH_LOGOUT = 'AUTH_LOGOUT',
  AUTH_CSRF_FAILURE = 'AUTH_CSRF_FAILURE',
  // P1-004 — refresh-token rotation + reuse detection (additive only; existing
  // AuditService methods/semantics unchanged per the P1-003 narrow exemption).
  AUTH_REFRESH_SUCCESS = 'AUTH_REFRESH_SUCCESS',
  AUTH_REFRESH_FAILURE = 'AUTH_REFRESH_FAILURE',
  AUTH_REFRESH_REUSE = 'AUTH_REFRESH_REUSE',
  AUTH_SESSION_REVOKED = 'AUTH_SESSION_REVOKED',
  AUTH_REFRESH_BODY_IGNORED = 'AUTH_REFRESH_BODY_IGNORED',
  AUTH_TRANSPORT_CONFLICT = 'AUTH_TRANSPORT_CONFLICT',
  // P1-006 — Backend RBAC decision audit (application-level only).
  // Provisioning ops actions (AUTHZ_ROLE_GRANTED / AUTHZ_ROLE_REVOKED) are
  // written by the controlled provisioning SQL transaction, NOT by application
  // code, so they are intentionally NOT added here (AuditLog.action is a
  // string column and accepts those values without an enum entry).
  AUTHZ_DECISION_DENIED = 'AUTHZ_DECISION_DENIED',
  AUTHZ_DECISION_ALLOWED = 'AUTHZ_DECISION_ALLOWED',
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: AppErrorCode | string;
  public readonly details?: unknown;
  /** Machine-readable sub-code (e.g. `AuthFailReason.*`). Logged but never returned to clients. */
  public readonly reason?: string;

  constructor(
    statusCode: number,
    code: AppErrorCode | string,
    message: string,
    opts?: { details?: unknown; reason?: string },
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = opts?.details;
    this.reason = opts?.reason;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static badRequest(
    message: string,
    detailsOrOpts?: unknown | { reason?: string; details?: unknown },
  ): AppError {
    const opts = normalizeDetails(detailsOrOpts);
    return new AppError(400, AppErrorCode.BAD_REQUEST, message, opts);
  }

  static validation(
    message: string,
    detailsOrOpts?: unknown | { reason?: string; details?: unknown },
  ): AppError {
    const opts = normalizeDetails(detailsOrOpts);
    return new AppError(422, AppErrorCode.VALIDATION_ERROR, message, opts);
  }

  static unauthorized(
    message = 'Unauthorized',
    opts?: { reason?: string; details?: unknown },
  ): AppError {
    return new AppError(401, AppErrorCode.UNAUTHORIZED, message, opts || {});
  }

  static forbidden(message = 'Forbidden', opts?: { reason?: string; details?: unknown }): AppError {
    return new AppError(403, AppErrorCode.FORBIDDEN, message, opts || {});
  }

  static notFound(message = 'Not Found', opts?: { reason?: string }): AppError {
    return new AppError(404, AppErrorCode.NOT_FOUND, message, { reason: opts?.reason });
  }

  static conflict(
    message: string,
    detailsOrOpts?: unknown | { reason?: string; details?: unknown },
  ): AppError {
    const opts = normalizeDetails(detailsOrOpts);
    return new AppError(409, AppErrorCode.CONFLICT, message, opts);
  }

  static rateLimited(message = 'Too Many Requests', opts?: { reason?: string }): AppError {
    return new AppError(429, AppErrorCode.RATE_LIMITED, message, { reason: opts?.reason });
  }

  static unavailable(message = 'Service Unavailable', opts?: { reason?: string }): AppError {
    return new AppError(503, AppErrorCode.SERVICE_UNAVAILABLE, message, { reason: opts?.reason });
  }

  static internal(message = 'Internal Server Error', opts?: { reason?: string }): AppError {
    return new AppError(500, AppErrorCode.INTERNAL_ERROR, message, { reason: opts?.reason });
  }
}

/**
 * Backwards-compat helper: accept `{ reason?, details? }` style or a raw
 * details value (as used by P1-001 callers). This keeps the release branch
 * green without touching every caller site.
 */
function normalizeDetails(input: unknown): { reason?: string | undefined; details?: unknown } {
  if (input === undefined || input === null) return {};
  if (
    typeof input === 'object' &&
    !Array.isArray(input) &&
    ('reason' in input || 'details' in input)
  ) {
    const rec = input as { reason?: string; details?: unknown };
    return {
      reason: typeof rec.reason === 'string' ? rec.reason : undefined,
      details: 'details' in rec ? rec.details : undefined,
    };
  }
  return { details: input };
}
