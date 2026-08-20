import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env, SERVICE_NAMES } from '@ai-wealth/config';
import { createLogger } from '@ai-wealth/shared';

export interface RedisComponentHealth {
  status: 'ok' | 'down';
  latencyMs?: number;
  error?: string;
}

/**
 * Shared Redis connection. Used in P0 for the health probe; future phases use
 * it for cache, rate-limit storage, distributed locks, session, idempotency,
 * and as the BullMQ backend (the Worker service holds its own connections).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;
  private readonly logger = createLogger(SERVICE_NAMES.API);

  constructor() {
    this.client = new Redis(env().redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
  }

  get connection(): Redis {
    return this.client;
  }

  async ping(): Promise<RedisComponentHealth> {
    const start = Date.now();
    try {
      const reply = await this.client.ping();
      if (reply !== 'PONG') {
        return { status: 'down', error: `unexpected PING reply: ${reply}` };
      }
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      this.logger.warn('redis ping failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'down', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // ignore — process is shutting down
    }
  }
}
