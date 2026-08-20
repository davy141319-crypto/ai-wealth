/** Stable service identifiers used in logs, queue names, and metrics. */
export const SERVICE_NAMES = {
  API: 'api',
  WORKER: 'worker',
  BLOCKCHAIN: 'blockchain',
  WEB: 'web',
  ADMIN: 'admin',
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];

/** Namespacing prefix for all Redis keys to avoid collisions. */
export const REDIS_KEY_PREFIX = 'aiwealth:';

/**
 * BullMQ queue names. Add new queues here as a single source of truth.
 * NOTE: BullMQ forbids `:` in queue names (collides with Redis key namespacing).
 * Use hyphens / camelCase instead.
 */
export const QUEUES = {
  DEFAULT: 'aiwealth-default',
  HEALTH_CHECK: 'aiwealth-health-check',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
