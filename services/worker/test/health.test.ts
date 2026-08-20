import { buildWorkerHealth } from '../src/health';

describe('buildWorkerHealth', () => {
  it('reports ok when redis is ok and surfaces lastJobAt', () => {
    const body = buildWorkerHealth({ status: 'ok', latencyMs: 3 }, '2026-01-01T00:00:00.000Z');
    expect(body.status).toBe('ok');
    expect(body.service).toBe('worker');
    expect(body.checks.redis.status).toBe('ok');
    expect(body.lastJobAt).toBe('2026-01-01T00:00:00.000Z');
    expect(typeof body.timestamp).toBe('string');
  });

  it('reports down when redis is down and includes the error', () => {
    const body = buildWorkerHealth({ status: 'down', error: 'ECONNREFUSED' }, null);
    expect(body.status).toBe('down');
    expect(body.checks.redis.error).toBe('ECONNREFUSED');
    expect(body.lastJobAt).toBeNull();
  });
});
