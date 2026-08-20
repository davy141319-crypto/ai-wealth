import type { NextFunction, Response } from 'express';
import { RequestIdMiddleware, RequestWithId } from '../src/common/middleware/request-id.middleware';

function mockReq(getHeaderValue?: string): RequestWithId {
  return { get: () => getHeaderValue } as unknown as RequestWithId;
}

function mockRes(): { res: Response; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
  } as unknown as Response;
  return { res, headers };
}

describe('RequestIdMiddleware', () => {
  it('generates an id when no header is present and echoes it back', () => {
    const middleware = new RequestIdMiddleware();
    const req = mockReq(undefined);
    const { res, headers } = mockRes();
    let nextCalled = false;
    const next = (() => {
      nextCalled = true;
    }) as NextFunction;

    middleware.use(req, res, next);

    expect(req.requestId).toBeTruthy();
    expect(headers['X-Request-Id']).toBe(req.requestId);
    expect(nextCalled).toBe(true);
  });

  it('reuses an incoming X-Request-Id header value', () => {
    const middleware = new RequestIdMiddleware();
    const incoming = 'req-abc-123';
    const req = mockReq(incoming);
    const { res, headers } = mockRes();

    middleware.use(req, res, (() => undefined) as NextFunction);

    expect(req.requestId).toBe(incoming);
    expect(headers['X-Request-Id']).toBe(incoming);
  });

  it('generates a new id when the header is empty', () => {
    const middleware = new RequestIdMiddleware();
    const req = mockReq('   ');
    const { res } = mockRes();

    middleware.use(req, res, (() => undefined) as NextFunction);

    expect(req.requestId).toBeTruthy();
    expect(req.requestId).not.toBe('   ');
  });
});
