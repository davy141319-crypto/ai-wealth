import { loadEnv } from '../env';

describe('loadEnv', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'secret',
    WEB_APP_URL: 'http://localhost:3000',
    ADMIN_APP_URL: 'http://localhost:3001',
  };

  function setEnv(overrides: Record<string, string | undefined> = {}): void {
    const merged = { ...base, ...overrides };
    Object.entries(merged).forEach(([k, v]) => {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    });
  }

  it('parses required env vars with sensible defaults', () => {
    setEnv({ API_PORT: '5000', WORKER_CONCURRENCY: '8' });
    const cfg = loadEnv();
    expect(cfg.databaseUrl).toBe(base.DATABASE_URL);
    expect(cfg.apiPort).toBe(5000);
    expect(cfg.workerConcurrency).toBe(8);
    expect(cfg.apiPrefix).toBe('api');
    expect(cfg.isProd).toBe(false);
  });

  it('throws when a required var is missing', () => {
    setEnv({ DATABASE_URL: undefined });
    expect(() => loadEnv('api')).toThrow(/DATABASE_URL/);
  });

  it('detects production mode', () => {
    setEnv({ NODE_ENV: 'production' });
    expect(loadEnv('api').isProd).toBe(true);
  });

  it('api preset requires DATABASE_URL / JWT_SECRET / WEB_APP_URL / ADMIN_APP_URL', () => {
    setEnv({ DATABASE_URL: undefined });
    expect(() => loadEnv('api')).toThrow(/DATABASE_URL/);
    setEnv({ DATABASE_URL: base.DATABASE_URL, JWT_SECRET: undefined });
    expect(() => loadEnv('api')).toThrow(/JWT_SECRET/);
  });

  it('worker preset only requires REDIS_URL (DB / JWT / app URLs optional)', () => {
    setEnv({
      DATABASE_URL: undefined,
      JWT_SECRET: undefined,
      WEB_APP_URL: undefined,
      ADMIN_APP_URL: undefined,
    });
    const cfg = loadEnv('worker');
    expect(cfg.redisUrl).toBe(base.REDIS_URL);
    expect(cfg.databaseUrl).toBe('');
    expect(cfg.jwtSecret).toBe('');
  });

  it('blockchain preset only requires REDIS_URL', () => {
    setEnv({
      DATABASE_URL: undefined,
      JWT_SECRET: undefined,
      WEB_APP_URL: undefined,
      ADMIN_APP_URL: undefined,
    });
    expect(() => loadEnv('blockchain')).not.toThrow();
  });

  it('worker preset still throws when REDIS_URL is missing', () => {
    setEnv({ REDIS_URL: undefined });
    expect(() => loadEnv('worker')).toThrow(/REDIS_URL/);
  });
});
