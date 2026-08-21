import { AppError, AppErrorCode } from './error-codes';

/** Standard success envelope returned by every API endpoint. */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
  timestamp: string;
}

/** Standard error envelope. Never leaks SQL / stack / secrets. */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/** Build a success envelope. */
export function ok<T>(data: T, meta?: Record<string, unknown>): ApiSuccessResponse<T> {
  return {
    success: true,
    data,
    ...(meta ? { meta } : {}),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build an error envelope. Generic errors are masked in production to avoid
 * leaking SQL, stack traces, internal paths or secrets.
 */
export function fail(error: AppError | Error): ApiErrorResponse {
  const isApp = error instanceof AppError;
  const isProd = process.env.NODE_ENV === 'production';
  const code = isApp ? error.code : AppErrorCode.INTERNAL_ERROR;
  const message = !isApp && isProd ? 'Internal Server Error' : error.message;
  let details: unknown | undefined;
  if (isApp) {
    if (error.details !== undefined) {
      details = error.details;
    } else if (error.reason !== undefined) {
      // For auth / business errors, the machine-readable `reason` lives on the
      // error itself; expose it as `details.reason` so clients can branch on
      // a stable location (r.body.error.details.reason).
      details = { reason: error.reason };
    }
  }
  return {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
    timestamp: new Date().toISOString(),
  };
}
