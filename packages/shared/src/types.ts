/** Common cross-service types shared by API / Worker / apps. */

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  meta: PaginationMeta;
}

export type HealthState = 'ok' | 'degraded' | 'down';

export interface ComponentHealth {
  status: 'ok' | 'down';
  latencyMs?: number;
  error?: string;
}

export interface HealthStatus {
  status: HealthState;
  service: string;
  timestamp: string;
  checks: Record<string, ComponentHealth>;
}

/** Idempotency record contract (used in future phases; defined now for schema). */
export interface IdempotencyRecord {
  key: string;
  status: 'pending' | 'completed' | 'failed';
  responseHash?: string;
  expiresAt: string;
}
