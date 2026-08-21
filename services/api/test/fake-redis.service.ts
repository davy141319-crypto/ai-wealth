/**
 * Lightweight in-memory Redis mock for auth tests.
 *
 * P1-002/P1-003: mimics the commands used by JwtAuthService — setex / get / del
 * / exists / ping — with TTL expiry simulation.
 *
 * P1-004 (refresh rotation): extended to support the commands used by
 * RefreshTokenService:
 *   - `set(key, value, 'EX', ttlSec)` and plain `set(key, value)`
 *   - `multi().set(...).set(...).del(...).exec()` (queued, executed on exec)
 *   - `eval(script, numkeys, ...keysAndArgs)` — detects the refresh-rotation
 *     Lua script (by its `P1-004 Refresh Token Rotation` marker) and runs a
 *     faithful TypeScript port against the in-memory store so the rotation
 *     state machine (5 outcomes + atomic family revocation) is exercised
 *     deterministically without a real Redis + Lua interpreter.
 *   - `evalsha(sha, numkeys, ...keysAndArgs)` — resolves the cached script and
 *     dispatches to the same port.
 *   - `script('LOAD', src)` — returns a synthetic SHA-1 and caches script ↔ sha.
 *
 * The TypeScript port mirrors refresh-rotation.lua line-for-line (same keys,
 * same 5 return codes, same TTL = family remaining lifetime). Keeping the port
 * in lock-step with the Lua is verified by the R-test rotation scenarios
 * (R03/R05/R06/R07/R08/R17) which assert the same outcomes a real Redis would.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';

interface StoreEntry {
  value: string;
  expiresAt: number; // epoch ms; Number.MAX_SAFE_INTEGER => no expiry
}

/** ioredis-style MULTI pipeline: queues commands, runs them on exec(). */
class FakeMulti {
  private readonly ops: Array<() => void> = [];

  constructor(private readonly fake: FakeRedisService) {}

  set(key: string, value: string, ...rest: unknown[]): this {
    this.ops.push(() => this.fake._set(key, value, rest));
    return this;
  }

  del(...keys: string[]): this {
    this.ops.push(() => {
      for (const k of keys) this.fake._del(k);
    });
    return this;
  }

  /** Execute queued commands. Returns ioredis-style [err, reply] tuples. */
  async exec(): Promise<Array<[Error | null, unknown]>> {
    const results: Array<[Error | null, unknown]> = [];
    for (const op of this.ops) {
      op();
      results.push([null, 'OK']);
    }
    return results;
  }
}

@Injectable()
export class FakeRedisService implements OnModuleDestroy {
  private readonly store = new Map<string, StoreEntry>();
  /** script sha → source, populated by script('LOAD', src). */
  private readonly shaToSrc = new Map<string, string>();
  private readonly srcToSha = new Map<string, string>();

  constructor() {
    // no-op: holds memory only
  }

  // --------------------------------------------------------------------------
  // Internal store primitives (with TTL expiry). Used by both the connection
  // command wrappers and the rotation Lua port so the port sees the SAME
  // store + expiry semantics as a real Redis.
  // --------------------------------------------------------------------------

  _get(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  /** Set with optional TTL. `rest` follows ioredis set() arg layout: ['EX', sec]. */
  _set(key: string, value: string, rest?: unknown[]): void {
    let ttlSec: number | undefined;
    if (rest && rest[0] === 'EX') ttlSec = Number(rest[1]);
    this._setTtl(key, value, ttlSec);
  }

  _setTtl(key: string, value: string, ttlSec?: number): void {
    const expiresAt =
      ttlSec !== undefined && ttlSec > 0 ? Date.now() + ttlSec * 1000 : Number.MAX_SAFE_INTEGER;
    this.store.set(key, { value, expiresAt });
  }

  _del(key: string): number {
    return this.store.delete(key) ? 1 : 0;
  }

  _exists(key: string): number {
    return this._get(key) !== null ? 1 : 0;
  }

  /** Remaining TTL in seconds (like Redis TTL); -1 if no expiry, -2 if absent. */
  _ttl(key: string): number {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === Number.MAX_SAFE_INTEGER) return -1;
    const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    if (remaining <= 0) {
      this.store.delete(key);
      return -2;
    }
    return remaining;
  }

  // --------------------------------------------------------------------------
  // Public connection surface (duck-typed as ioredis by consumers).
  // --------------------------------------------------------------------------

  get connection(): {
    setex: (key: string, ttlSec: number, value: string) => Promise<'OK'>;
    set: (key: string, value: string, ...rest: unknown[]) => Promise<'OK'>;
    get: (key: string) => Promise<string | null>;
    del: (...keys: string[]) => Promise<number>;
    exists: (key: string) => Promise<number>;
    ping: () => Promise<'PONG'>;
    multi: () => FakeMulti;
    eval: (script: string, numkeys: number, ...keysAndArgs: string[]) => Promise<unknown>;
    evalsha: (sha: string, numkeys: number, ...keysAndArgs: string[]) => Promise<unknown>;
    script: (subcommand: string, ...args: string[]) => Promise<string>;
  } {
    const self = this;
    return {
      async setex(key: string, ttlSec: number, value: string): Promise<'OK'> {
        self._setTtl(key, value, ttlSec);
        return 'OK';
      },
      async set(key: string, value: string, ...rest: unknown[]): Promise<'OK'> {
        self._set(key, value, rest);
        return 'OK';
      },
      async get(key: string): Promise<string | null> {
        return self._get(key);
      },
      async del(...keys: string[]): Promise<number> {
        let removed = 0;
        for (const k of keys) removed += self._del(k);
        return removed;
      },
      async exists(key: string): Promise<number> {
        return self._exists(key);
      },
      async ping(): Promise<'PONG'> {
        return 'PONG';
      },
      multi(): FakeMulti {
        return new FakeMulti(self);
      },
      async eval(script: string, _numkeys: number, ...keysAndArgs: string[]): Promise<unknown> {
        return self.runScript(script, keysAndArgs);
      },
      async evalsha(sha: string, _numkeys: number, ...keysAndArgs: string[]): Promise<unknown> {
        const src = self.shaToSrc.get(sha);
        if (!src) {
          const err = new Error('NOSCRIPT No matching script. Please use EVAL.');
          throw err;
        }
        return self.runScript(src, keysAndArgs);
      },
      async script(subcommand: string, ...args: string[]): Promise<string> {
        if (subcommand.toUpperCase() === 'LOAD') {
          const src = args[0] ?? '';
          let sha = self.srcToSha.get(src);
          if (!sha) {
            // Synthetic 40-hex SHA-1 digest (content does not need to be real;
            // evalsha just looks it up in self.shaToSrc).
            sha = self.syntheticSha(src);
            self.shaToSrc.set(sha, src);
            self.srcToSha.set(src, sha);
          }
          return sha;
        }
        return 'OK';
      },
    };
  }

  clear(): void {
    this.store.clear();
    this.shaToSrc.clear();
    this.srcToSha.clear();
  }

  async onModuleDestroy(): Promise<void> {
    this.clear();
  }

  // --------------------------------------------------------------------------
  // TEST-ONLY debug helpers (prefixed __). Used by the R-test suite to simulate
  // time passage for Redis key TTL expiry AND logical timestamps stored inside
  // JSON values (familyExpiresAt / retryGraceUntil / usedAt / issuedAt / etc.)
  // without waiting real seconds. NOT part of the ioredis surface.
  // --------------------------------------------------------------------------

  /** Remaining TTL in seconds for a key (-1 no expiry, -2 absent/expired). */
  __debugTtl(key: string): number {
    return this._ttl(key);
  }

  /** Raw value of a key (no expiry side-effect). Returns null if absent. */
  __debugGet(key: string): string | null {
    return this.store.get(key)?.value ?? null;
  }

  /** List store keys matching a literal prefix (e.g. 'refresh:family:'). */
  __debugKeys(prefix: string): string[] {
    const out: string[] = [];
    for (const k of this.store.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }

  /**
   * Simulate `seconds` of wall-clock passing for BOTH key TTL expiry and the
   * logical timestamps embedded in JSON values (familyExpiresAt, retryGraceUntil,
   * usedAt, issuedAt, createdAt, revokedAt). Expires (deletes) any key whose
   * TTL has elapsed. This lets R06 (grace elapsed → 403), R26 (family near
   * expiry → short TTL), and R27 (family expired → 401) run deterministically
   * without real waits or jest fake timers (which can interfere with supertest
   * async I/O).
   */
  __fastForwardAll(seconds: number): void {
    const tsFields = new Set([
      'familyExpiresAt',
      'createdAt',
      'usedAt',
      'issuedAt',
      'retryGraceUntil',
      'revokedAt',
    ]);
    for (const [, entry] of this.store) {
      if (entry.expiresAt !== Number.MAX_SAFE_INTEGER) {
        entry.expiresAt -= seconds * 1000;
      }
      if (entry.value.startsWith('{')) {
        try {
          const obj = JSON.parse(entry.value) as Record<string, unknown>;
          let mutated = false;
          for (const f of tsFields) {
            if (typeof obj[f] === 'number') {
              obj[f] = (obj[f] as number) - seconds;
              mutated = true;
            }
          }
          if (mutated) entry.value = JSON.stringify(obj);
        } catch {
          /* not JSON — skip */
        }
      }
    }
    // Purge keys whose TTL has elapsed (matches Redis lazy expiry on read).
    const now = Date.now();
    for (const [k, entry] of this.store) {
      if (entry.expiresAt !== Number.MAX_SAFE_INTEGER && entry.expiresAt < now) {
        this.store.delete(k);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Lua script execution — TypeScript port of refresh-rotation.lua.
  // --------------------------------------------------------------------------

  /**
   * Detect the refresh-rotation script by its marker comment and run the TS
   * port. `keysAndArgs` = KEYS[1..numkeys] then ARGV[1..]. Only KEYS[1] (the
   * lookup key) is dynamic for the rotation script; the rest are derived from
   * familyId inside the port (matching the Lua exactly).
   */
  private runScript(script: string, keysAndArgs: string[]): unknown {
    if (script.includes('P1-004 Refresh Token Rotation')) {
      return this.runRefreshRotation(keysAndArgs);
    }
    throw new Error(
      `FakeRedisService.eval: unknown script (first 40 chars): ${script.slice(0, 40)}`,
    );
  }

  /**
   * Faithful TS port of refresh-rotation.lua. Same keys, same 5 return codes,
   * same TTL = family remaining lifetime. Atomicity is approximated by
   * synchronous execution (Node single-threaded; no await between reads and
   * writes) which matches Redis' single-threaded Lua execution.
   *
   * keysAndArgs layout (numkeys=1):
   *   [0] = KEYS[1] = refresh:lookup:{tokenHash}
   *   [1] = ARGV[1] = tokenHash
   *   [2] = ARGV[2] = now (sec)
   *   [3] = ARGV[3] = graceSec
   *   [4] = ARGV[4] = maxRetry
   *   [5] = ARGV[5] = newTokenHash
   *   [6] = ARGV[6] = newActiveMeta (JSON)
   */
  private runRefreshRotation(keysAndArgs: string[]): [number, string] {
    const lookupKey = keysAndArgs[0];
    const tokenHash = keysAndArgs[1];
    const now = Number(keysAndArgs[2]);
    const graceSec = Number(keysAndArgs[3]);
    const maxRetry = Number(keysAndArgs[4]);
    const newTokenHash = keysAndArgs[5];
    const newActiveMeta = keysAndArgs[6];

    // 1. Locate family via lookup (kept until family expiry).
    const familyId = this._get(lookupKey);
    if (!familyId) return [4, ''];

    const kFamily = `refresh:family:${familyId}`;
    const kActive = `refresh:active:${familyId}`;
    const kUsed = `refresh:used:${familyId}:${tokenHash}`;
    const kRevoked = `refresh:revoked:${familyId}`;

    // 2. Already revoked?
    if (this._exists(kRevoked) > 0) return [3, ''];
    const famRaw = this._get(kFamily);
    if (!famRaw) return [4, '']; // family TTL elapsed
    const fam = JSON.parse(famRaw) as {
      userId: string;
      walletId: string;
      status: 'ACTIVE' | 'REVOKED';
      createdAt: number;
      familyExpiresAt: number;
    };
    if (fam.status === 'REVOKED') return [3, ''];

    // Family remaining lifetime (decrementing; rotation never extends it).
    const remainingTtl = Math.floor(fam.familyExpiresAt - now);
    if (remainingTtl <= 0) return [4, ''];

    // 3. Is the presented token the current active token? → normal rotation.
    const activeRaw = this._get(kActive);
    if (activeRaw) {
      const am = JSON.parse(activeRaw) as { tokenHash: string; issuedAt: number };
      if (am.tokenHash === tokenHash) {
        // Tombstone the used token (kept until family expiry so a later replay
        // can still be classified RETRY vs REUSED). TTL = family remaining.
        this._setTtl(
          kUsed,
          JSON.stringify({
            usedAt: now,
            retryGraceUntil: now + graceSec,
            retryCount: 0,
          }),
          remainingTtl,
        );
        // Remove the old active pointer (a family has at most one active token).
        this._del(kActive);
        // Do NOT delete refresh:lookup:{oldHash} — kept until family expiry so a
        // replayed used token still resolves to this family for reuse detection.
        // Install the new active token + its lookup (TTL = family remaining).
        this._setTtl(kActive, newActiveMeta, remainingTtl);
        this._setTtl(`refresh:lookup:${newTokenHash}`, familyId, remainingTtl);
        return [0, newActiveMeta];
      }
    }

    // 4. Not the active token → check the used tombstone.
    const usedRaw = this._get(kUsed);
    if (usedRaw) {
      const um = JSON.parse(usedRaw) as {
        usedAt: number;
        retryGraceUntil: number;
        retryCount: number;
      };
      if (now < um.retryGraceUntil) {
        // Inside the grace window: increment replay counter.
        um.retryCount = um.retryCount + 1;
        this._setTtl(kUsed, JSON.stringify(um), remainingTtl);
        if (um.retryCount > maxRetry) {
          // Replays exceeded the tolerance threshold → theft. Revoke atomically.
          this._setTtl(
            kRevoked,
            JSON.stringify({ revokedAt: now, reason: 'REUSE_DETECTED' }),
            remainingTtl,
          );
          fam.status = 'REVOKED';
          this._setTtl(kFamily, JSON.stringify(fam), remainingTtl);
          this._del(kActive);
          return [2, ''];
        }
        // Tolerated retry — no token returned (plaintext not stored).
        return [1, ''];
      }
      // Grace window elapsed but tombstone still present → theft. Revoke.
      this._setTtl(
        kRevoked,
        JSON.stringify({ revokedAt: now, reason: 'REUSE_DETECTED' }),
        remainingTtl,
      );
      fam.status = 'REVOKED';
      this._setTtl(kFamily, JSON.stringify(fam), remainingTtl);
      this._del(kActive);
      return [2, ''];
    }

    // 5. Lookup exists but token is neither active nor used: invalid.
    return [4, ''];
  }

  /** Stable synthetic 40-char hex SHA-1-like digest from source content. */
  private syntheticSha(src: string): string {
    // Simple FNV-1a hash folded into 40 hex chars. Deterministic per source so
    // script('LOAD', src) is idempotent (same src → same sha).
    let h1 = 0x811c9dc5;
    let h2 = 0x1000193;
    for (let i = 0; i < src.length; i++) {
      const c = src.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (c + 0x9e), 0x01000193) >>> 0;
    }
    const hex = (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
    return (hex + hex + hex + hex + hex).slice(0, 40);
  }
}
