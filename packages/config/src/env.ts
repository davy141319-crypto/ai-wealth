/**
 * Strongly-typed, validated environment configuration.
 *
 * `required()` throws on missing values so services fail fast at boot rather
 * than silently misbehaving. No real secrets are read from code — everything
 * sensitive comes from the environment / .env (never committed).
 *
 * Per-service strictness:
 * Different services need different subsets of the env. The loader takes a
 * `preset` so that, e.g., the worker (which only talks to Redis) doesn't fail
 * boot because `JWT_SECRET` (an API-only concern) is unset. Each preset pins
 * exactly the variables that service actually reads.
 *
 * NOTE: this package is intentionally dependency-free (it does not import
 * @ai-wealth/shared) so it can be type-checked and built in isolation, keeping
 * the leaf packages independent in the workspace dependency graph.
 */
export type ServicePreset = 'api' | 'worker' | 'blockchain';

export interface EnvConfig {
  nodeEnv: string;
  isProd: boolean;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  apiPort: number;
  apiPrefix: string;
  webAppUrl: string;
  adminAppUrl: string;
  nextPublicApiUrl: string;
  nextPublicAppUrl: string;
  workerConcurrency: number;
  workerPort: number;
  blockchainPort: number;
  /** Allowed SIWE domain whitelist (default: WEB_APP_URL host). */
  siweDomain: string;
  /** Allowed SIWE URI whitelist (default: WEB_APP_URL). */
  siweUri: string;
  /** Human-readable statement embedded in SIWE messages. */
  siweStatement: string;
  /** AuthNonce TTL in seconds (default 300 = 5 min). */
  siweNonceTtlSec: number;
  /** Max allowed issuedAt clock skew in seconds (default 300). */
  siweClockSkewSec: number;
  /**
   * Access-token cookie name. Production uses the `__Host-` prefix (requires
   * HTTPS, Path=/, no Domain) to bind the cookie to the current host; dev/test
   * use the plain name so it works over localhost HTTP.
   */
  cookieName: string;
  /** CSRF token cookie name (same `__Host-` strategy as access cookie). */
  csrfCookieName: string;
  /** Cookie Domain attribute. Empty string means "do not set" (host-only). */
  cookieDomain: string;
  /** Cookie Secure flag (true in production over HTTPS, false in dev/test). */
  cookieSecure: boolean;
  /** Cookie SameSite attribute ('lax' | 'strict' | 'none'). */
  cookieSameSite: 'lax' | 'strict' | 'none';
  /** Cookie Path attribute. `__Host-` cookies must use '/'. */
  cookiePath: string;
  /** Header name clients use to submit the CSRF token (Double Submit Cookie). */
  csrfHeaderName: string;
}

/** Fatal configuration error — crashes the process at boot by design. */
export class ConfigError extends Error {
  public readonly missing: string[];
  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.missing = missing;
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

function required(name: string, missing: string[]): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    missing.push(name);
    return '';
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function asInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

/** Variables each preset strictly requires at boot. */
const REQUIRED_BY_PRESET: Record<ServicePreset, string[]> = {
  // API: writes JWTs, talks to Postgres + Redis, must know allowed CORS origins.
  api: ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'WEB_APP_URL', 'ADMIN_APP_URL'],
  // Worker: only needs Redis (BullMQ). Does not read DB or JWT in P0.
  worker: ['REDIS_URL'],
  // Blockchain listener (P0 placeholder): only needs Redis for future event queue.
  blockchain: ['REDIS_URL'],
};

/** Extract the host portion from a URL. Returns the string unchanged if parse fails. */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

/**
 * Load and validate environment for the given service preset.
 * @param preset which service is booting — controls which vars are required.
 */
export function loadEnv(preset: ServicePreset = 'api'): EnvConfig {
  const missing: string[] = [];
  const nodeEnv = optional('NODE_ENV', 'development');

  // Always-required-for-this-preset vars:
  for (const name of REQUIRED_BY_PRESET[preset]) {
    required(name, missing);
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables for preset "${preset}": ${missing.join(', ')}`,
      missing,
    );
  }

  const webAppUrl = optional('WEB_APP_URL', '');
  const siweDomain = optional('SIWE_DOMAIN', webAppUrl ? hostOf(webAppUrl) : 'localhost');
  const siweUri = optional('SIWE_URI', webAppUrl || 'http://localhost:3000');
  const siweStatement = optional('SIWE_STATEMENT', 'Sign in with Ethereum to AI Wealth DApp.');

  const isProd = nodeEnv === 'production';
  // Cookie/CSRF config — `__Host-` prefix in production requires HTTPS + Path=/
  // + no Domain; dev/test fall back to plain names over localhost HTTP.
  const cookieName = optional('COOKIE_NAME', isProd ? '__Host-accesstoken' : 'access_token');
  const csrfCookieName = optional('CSRF_COOKIE_NAME', isProd ? '__Host-csrf' : 'csrf');
  const cookieSameSiteRaw = optional('COOKIE_SAMESITE', 'lax').toLowerCase();
  const cookieSameSite =
    cookieSameSiteRaw === 'strict' || cookieSameSiteRaw === 'none'
      ? (cookieSameSiteRaw as 'strict' | 'none')
      : 'lax';

  return {
    nodeEnv,
    isProd,
    // Read every var regardless of preset so callers that do use them get the
    // real value when present (empty string when absent — never throws).
    databaseUrl: optional('DATABASE_URL', ''),
    redisUrl: optional('REDIS_URL', ''),
    jwtSecret: optional('JWT_SECRET', ''),
    jwtExpiresIn: optional('JWT_EXPIRES_IN', '3600s'),
    apiPort: asInt('API_PORT', 4000),
    apiPrefix: optional('API_PREFIX', 'api'),
    webAppUrl,
    adminAppUrl: optional('ADMIN_APP_URL', ''),
    nextPublicApiUrl: optional('NEXT_PUBLIC_API_URL', ''),
    nextPublicAppUrl: optional('NEXT_PUBLIC_APP_URL', ''),
    workerConcurrency: asInt('WORKER_CONCURRENCY', 4),
    workerPort: asInt('WORKER_PORT', 4001),
    blockchainPort: asInt('BLOCKCHAIN_PORT', 4002),
    siweDomain,
    siweUri,
    siweStatement,
    siweNonceTtlSec: asInt('SIWE_NONCE_TTL_SEC', 300),
    siweClockSkewSec: asInt('SIWE_CLOCK_SKEW_SEC', 300),
    cookieName,
    csrfCookieName,
    cookieDomain: optional('COOKIE_DOMAIN', ''),
    cookieSecure: optional('COOKIE_SECURE', isProd ? 'true' : 'false').toLowerCase() === 'true',
    cookieSameSite,
    cookiePath: optional('COOKIE_PATH', '/'),
    csrfHeaderName: optional('CSRF_HEADER_NAME', 'X-CSRF-TOKEN'),
  };
}

let cached: EnvConfig | null = null;
let cachedPreset: ServicePreset | null = null;

/**
 * Cached singleton accessor — loads once per process.
 * @param preset which service is booting. Must be the same on every call
 *               within a single process; the first call wins.
 */
export function env(preset: ServicePreset = 'api'): EnvConfig {
  if (!cached) {
    cached = loadEnv(preset);
    cachedPreset = preset;
  } else if (cachedPreset !== preset) {
    // Surface misuse loudly rather than silently returning the wrong shape.
    throw new ConfigError(
      `env() was already initialised with preset "${cachedPreset}", ` +
        `but "${preset}" was requested. A process must use one preset only.`,
    );
  }
  return cached;
}

/**
 * Reset cached config — TEST ONLY helper. Never call in production code.
 * Used in Jest so different `process.env` values take effect across suites.
 */
export function _resetEnvCache(): void {
  cached = null;
  cachedPreset = null;
}
