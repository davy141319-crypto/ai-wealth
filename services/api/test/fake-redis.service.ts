/**
 * Lightweight in-memory Redis mock for auth tests.
 *
 * Only mimics the commands used by JwtAuthService: setex, get, del, exists.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class FakeRedisService implements OnModuleDestroy {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  constructor() {
    // no-op: holds memory only
  }

  get connection(): {
    setex: (key: string, ttlSec: number, value: string) => Promise<'OK'>;
    get: (key: string) => Promise<string | null>;
    del: (...keys: string[]) => Promise<number>;
    exists: (key: string) => Promise<number>;
    ping: () => Promise<'PONG'>;
  } {
    const self = this;
    return {
      async setex(key: string, ttlSec: number, value: string): Promise<'OK'> {
        self.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
        return 'OK';
      },
      async get(key: string): Promise<string | null> {
        const entry = self.store.get(key);
        if (!entry) return null;
        if (entry.expiresAt < Date.now()) {
          self.store.delete(key);
          return null;
        }
        return entry.value;
      },
      async del(...keys: string[]): Promise<number> {
        let removed = 0;
        for (const k of keys) if (self.store.delete(k)) removed++;
        return removed;
      },
      async exists(key: string): Promise<number> {
        const entry = self.store.get(key);
        if (!entry) return 0;
        if (entry.expiresAt < Date.now()) {
          self.store.delete(key);
          return 0;
        }
        return 1;
      },
      async ping(): Promise<'PONG'> {
        return 'PONG';
      },
    };
  }

  clear(): void {
    this.store.clear();
  }

  async onModuleDestroy(): Promise<void> {
    this.store.clear();
  }
}
