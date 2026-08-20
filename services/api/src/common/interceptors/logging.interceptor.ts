import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { tap } from 'rxjs';
import { createLogger } from '@ai-wealth/shared';
import { SERVICE_NAMES } from '@ai-wealth/config';
import type { RequestWithId } from '../middleware/request-id.middleware';

/**
 * Logs every HTTP request/response with its request_id and latency.
 * Structured JSON output via the shared logger so log pipelines are uniform.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = createLogger(SERVICE_NAMES.API);

  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithId>();
    const res = http.getResponse<Response>();
    const start = Date.now();
    const requestId = req.requestId ?? '-';
    const { method, url } = req;

    this.logger.info('request', { request_id: requestId, method, url });

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.info('response', {
            request_id: requestId,
            method,
            url,
            status: res.statusCode,
            latencyMs: Date.now() - start,
          });
        },
        error: (err: unknown) => {
          this.logger.error('request_error', {
            request_id: requestId,
            method,
            url,
            status: res.statusCode,
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      }),
    );
  }
}
