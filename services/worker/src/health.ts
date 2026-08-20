import { SERVICE_NAMES } from '@ai-wealth/config';
import type { ComponentHealth, HealthState } from '@ai-wealth/shared';

export interface WorkerHealth {
  status: HealthState;
  service: string;
  timestamp: string;
  checks: { redis: ComponentHealth };
  lastJobAt: string | null;
}

/**
 * Pure builder for the worker health body. Kept side-effect-free so it can be
 * unit-tested without a live Redis or BullMQ connection.
 */
export function buildWorkerHealth(redis: ComponentHealth, lastJobAt: string | null): WorkerHealth {
  const status: HealthState = redis.status === 'ok' ? 'ok' : 'down';
  return {
    status,
    service: SERVICE_NAMES.WORKER,
    timestamp: new Date().toISOString(),
    checks: { redis },
    lastJobAt,
  };
}
