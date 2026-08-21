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
}

/** AuditLog action names. Stable values; never rename. */
export enum AuditAction {
  AUTH_LOGIN_SUCCESS = 'AUTH_LOGIN_SUCCESS',
  AUTH_LOGIN_FAILURE = 'AUTH_LOGIN_FAILURE',
  AUTH_LOGOUT = 'AUTH_LOGOUT',
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
