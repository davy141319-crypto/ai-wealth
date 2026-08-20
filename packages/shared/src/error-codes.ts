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

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: AppErrorCode | string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: AppErrorCode | string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, AppErrorCode.BAD_REQUEST, message, details);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError(422, AppErrorCode.VALIDATION_ERROR, message, details);
  }

  static unauthorized(message = 'Unauthorized'): AppError {
    return new AppError(401, AppErrorCode.UNAUTHORIZED, message);
  }

  static forbidden(message = 'Forbidden'): AppError {
    return new AppError(403, AppErrorCode.FORBIDDEN, message);
  }

  static notFound(message = 'Not Found'): AppError {
    return new AppError(404, AppErrorCode.NOT_FOUND, message);
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, AppErrorCode.CONFLICT, message, details);
  }

  static rateLimited(message = 'Too Many Requests'): AppError {
    return new AppError(429, AppErrorCode.RATE_LIMITED, message);
  }

  static unavailable(message = 'Service Unavailable'): AppError {
    return new AppError(503, AppErrorCode.SERVICE_UNAVAILABLE, message);
  }

  static internal(message = 'Internal Server Error'): AppError {
    return new AppError(500, AppErrorCode.INTERNAL_ERROR, message);
  }
}
