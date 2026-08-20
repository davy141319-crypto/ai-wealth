import { ok, fail } from '../api-response';
import { AppError, AppErrorCode } from '../error-codes';

describe('ApiResponse envelope', () => {
  it('ok() builds a success envelope with timestamp', () => {
    const res = ok({ id: 1 });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ id: 1 });
    expect(typeof res.timestamp).toBe('string');
  });

  it('ok() includes meta only when provided', () => {
    expect(ok(1).meta).toBeUndefined();
    expect(ok(1, { page: 1 }).meta).toEqual({ page: 1 });
  });

  it('fail() serializes AppError with code and details', () => {
    const res = fail(AppError.badRequest('invalid', { field: 'x' }));
    expect(res.success).toBe(false);
    expect(res.error.code).toBe(AppErrorCode.BAD_REQUEST);
    expect(res.error.message).toBe('invalid');
    expect(res.error.details).toEqual({ field: 'x' });
  });

  it('fail() masks generic errors in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const res = fail(new Error('SQL syntax error near line 42'));
    expect(res.error.code).toBe(AppErrorCode.INTERNAL_ERROR);
    expect(res.error.message).toBe('Internal Server Error');
    process.env.NODE_ENV = prev;
  });

  it('fail() shows generic error detail in non-production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const res = fail(new Error('boom'));
    expect(res.error.message).toBe('boom');
    process.env.NODE_ENV = prev;
  });
});
