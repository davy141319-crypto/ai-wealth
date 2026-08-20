import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { AppError, createLogger, fail } from '@ai-wealth/shared';
import type { ApiErrorResponse } from '@ai-wealth/shared';
import { SERVICE_NAMES } from '@ai-wealth/config';
import type { RequestWithId } from '../middleware/request-id.middleware';

/**
 * Global exception filter.
 *
 * Converts every thrown error into the unified ApiErrorResponse envelope and
 * logs the full error server-side. Production NEVER returns SQL, stack traces,
 * internal paths, secrets, or private keys — generic errors are masked to a
 * generic "Internal Server Error" message.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = createLogger(SERVICE_NAMES.API);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<RequestWithId>();
    const requestId = req?.requestId ?? '-';
    const isProd = process.env.NODE_ENV === 'production';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let payload: ApiErrorResponse;

    if (exception instanceof AppError) {
      status = exception.statusCode;
      payload = fail(exception);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      const obj =
        typeof response === 'object' && response !== null
          ? (response as Record<string, unknown>)
          : undefined;
      const message = obj?.message
        ? Array.isArray(obj.message)
          ? (obj.message as unknown[]).join(', ')
          : String(obj.message)
        : exception.message;
      payload = {
        success: false,
        error: {
          code: obj?.error ? String(obj.error).toUpperCase().replace(/\s+/g, '_') : exception.name,
          message,
          ...(obj && obj.statusCode ? { details: { statusCode: obj.statusCode } } : {}),
        },
        timestamp: new Date().toISOString(),
      };
    } else {
      const inner = exception instanceof Error ? exception : new Error(String(exception));
      payload = fail(inner);
    }

    const stack = exception instanceof Error ? exception.stack : undefined;
    this.logger.error('unhandled_exception', {
      request_id: requestId,
      status,
      code: payload.error.code,
      message: payload.error.message,
      ...(!isProd && stack ? { stack } : {}),
    });

    // If headers already sent, Nest/Express will handle the rest; avoid double-write.
    if (!res.headersSent) {
      res.status(status).json(payload);
    }
  }
}
