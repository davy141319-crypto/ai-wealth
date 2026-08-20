import { Injectable } from '@nestjs/common';
import { dbHealth } from '@ai-wealth/database';
import type { ComponentHealth, HealthState, HealthStatus } from '@ai-wealth/shared';
import { SERVICE_NAMES } from '@ai-wealth/config';
import { RedisService } from '../common/redis/redis.service';

/**
 * Aggregates dependency health (PostgreSQL + Redis) into the shared
 * HealthStatus structure. Does NOT depend on any business table — the DB probe
 * runs `SELECT 1` via Prisma raw query.
 */
@Injectable()
export class HealthService {
  constructor(private readonly redis: RedisService) {}

  async check(): Promise<HealthStatus> {
    const [db, redis] = await Promise.all([dbHealth(), this.redis.ping()]);
    const checks: Record<string, ComponentHealth> = { postgres: db, redis };
    const okCount = (db.status === 'ok' ? 1 : 0) + (redis.status === 'ok' ? 1 : 0);
    const status: HealthState = okCount === 2 ? 'ok' : okCount === 0 ? 'down' : 'degraded';
    return {
      status,
      service: SERVICE_NAMES.API,
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}
