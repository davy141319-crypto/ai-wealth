import { prisma } from './client';

/** DB liveness probe shape (structurally compatible with shared ComponentHealth). */
export interface DbComponentHealth {
  status: 'ok' | 'down';
  latencyMs?: number;
  error?: string;
}

/**
 * Lightweight DB liveness probe: runs `SELECT 1` and reports latency.
 * Does NOT depend on any business table — safe for P0 (schema has no models).
 */
export async function dbHealth(): Promise<DbComponentHealth> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'down',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
