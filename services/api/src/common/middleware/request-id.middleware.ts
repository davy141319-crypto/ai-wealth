import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

/** Express request augmented with the per-request correlation id. */
export interface RequestWithId extends Request {
  requestId: string;
}

/**
 * Assigns a correlation id (request_id) to every request:
 *   - reuse an incoming `X-Request-Id` header if present,
 *   - otherwise generate a UUID v4.
 * The id is exposed on the request object, echoed back via the
 * `X-Request-Id` response header, and logged with every log line.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithId, res: Response, next: NextFunction): void {
    const incoming = req.get('x-request-id');
    const requestId = incoming && incoming.trim() !== '' ? incoming.trim() : randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  }
}
