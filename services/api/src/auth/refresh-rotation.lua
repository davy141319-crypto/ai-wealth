-- ============================================================================
-- P1-004 Refresh Token Rotation — atomic Lua script.
--
-- Implements the rotation state machine in Redis' single-threaded execution so
-- that concurrent refresh requests on the same token are serialised: exactly
-- one succeeds (code 0), the others get a deterministic retry/reuse verdict.
-- Reuse-detection family revocation happens IN THIS SCRIPT (no async window).
--
-- Keys (passed positionally; only the lookup key is dynamic — the rest are
-- derived from familyId inside the script so the caller cannot desync them):
--   KEYS[1] = refresh:lookup:{tokenHash}        (old token → familyId index)
--
-- ARGV:
--   [1] = tokenHash        (sha256 hex of the presented refresh token)
--   [2] = now             (unix seconds)
--   [3] = graceSec        (reuse retry grace window, e.g. 30)
--   [4] = maxRetry        (max replays within grace before theft, e.g. 2)
--   [5] = newTokenHash    (sha256 hex of the freshly generated new token)
--   [6] = newActiveMeta   (JSON: {tokenHash, issuedAt}) for refresh:active:{familyId}
--
-- Returns an array [code, payload]:
--   {0, newActiveMeta}  NORMAL   — rotation succeeded; caller already holds the
--                                  new token plaintext (generated pre-script);
--                                  write it to the cookie/body response.
--   {1, ''}             RETRY   — presented token was used recently and is still
--                                  inside the grace window with retryCount <=
--                                  maxRetry. HTTP 409. NO token plaintext is
--                                  returned (Redis never stores plaintext).
--   {2, ''}             REUSED  — theft confirmed (grace expired OR retryCount
--                                  exceeded). The family is revoked ATOMICALLY
--                                  in this script. HTTP 403 + audit + clear cookies.
--   {3, ''}             REVOKED — family already revoked. HTTP 403.
--   {4, ''}             INVALID — token/family not found (lookup miss, family
--                                  expired, or never existed). TTL-deleted keys
--                                  are indistinguishable from forged tokens, so
--                                  EXPIRED is NOT a separate code (V1 decision).
-- ============================================================================

local familyId = redis.call('GET', KEYS[1])
if not familyId then return {4, ''} end

local kFamily  = 'refresh:family:' .. familyId
local kActive  = 'refresh:active:' .. familyId
local kUsed    = 'refresh:used:' .. familyId .. ':' .. ARGV[1]
local kRevoked = 'refresh:revoked:' .. familyId

-- 1) Already revoked? (explicit revoke marker)
if redis.call('EXISTS', kRevoked) > 0 then return {3, ''} end

local famRaw = redis.call('GET', kFamily)
if not famRaw then return {4, ''} end   -- family TTL elapsed
local fam = cjson.decode(famRaw)
if fam.status == 'REVOKED' then return {3, ''} end

-- Family has a FIXED maximum lifetime; rotation NEVER extends it. Every key
-- (re)written here uses TTL = familyExpiresAt - now (decrementing).
local remainingTtl = math.floor(fam.familyExpiresAt - ARGV[2])
if remainingTtl <= 0 then return {4, ''} end

-- 2) Is the presented token the current active token? → normal rotation.
local activeRaw = redis.call('GET', kActive)
if activeRaw then
  local am = cjson.decode(activeRaw)
  if am.tokenHash == ARGV[1] then
    -- Tombstone the used token (kept until family expiry so a later replay can
    -- still be classified RETRY vs REUSED). TTL = family remaining lifetime.
    redis.call('SET', kUsed, cjson.encode({
      usedAt = ARGV[2],
      retryGraceUntil = ARGV[2] + ARGV[3],
      retryCount = 0
    }), 'EX', remainingTtl)
    -- Remove the old active pointer (a family has at most one active token).
    redis.call('DEL', kActive)
    -- IMPORTANT: do NOT delete refresh:lookup:{oldHash}. The old lookup is kept
    -- until family expiry so a replayed used token can still resolve to this
    -- family and be judged via the used tombstone (RETRY/REUSED). Deleting it
    -- would make a replay look like a forged token (code 4) and skip reuse
    -- detection entirely.
    -- Install the new active token + its lookup (TTL = family remaining).
    redis.call('SET', kActive, ARGV[6], 'EX', remainingTtl)
    redis.call('SET', 'refresh:lookup:' .. ARGV[5], familyId, 'EX', remainingTtl)
    return {0, ARGV[6]}
  end
end

-- 3) Not the active token → check the used tombstone.
local usedRaw = redis.call('GET', kUsed)
if usedRaw then
  local um = cjson.decode(usedRaw)
  if ARGV[2] < um.retryGraceUntil then
    -- Inside the grace window: increment replay counter, decide retry vs theft.
    um.retryCount = um.retryCount + 1
    redis.call('SET', kUsed, cjson.encode(um), 'EX', remainingTtl)
    if um.retryCount > tonumber(ARGV[4]) then
      -- Replays exceeded the tolerance threshold → theft. Revoke the family
      -- ATOMICALLY inside this script (no async gap).
      redis.call('SET', kRevoked, cjson.encode({
        revokedAt = ARGV[2],
        reason = 'REUSE_DETECTED'
      }), 'EX', remainingTtl)
      fam.status = 'REVOKED'
      redis.call('SET', kFamily, cjson.encode(fam), 'EX', remainingTtl)
      redis.call('DEL', kActive)
      return {2, ''}
    end
    -- Tolerated retry — no token returned (we don't store plaintext).
    return {1, ''}
  else
    -- Grace window elapsed but tombstone still present → theft. Revoke.
    redis.call('SET', kRevoked, cjson.encode({
      revokedAt = ARGV[2],
      reason = 'REUSE_DETECTED'
    }), 'EX', remainingTtl)
    fam.status = 'REVOKED'
    redis.call('SET', kFamily, cjson.encode(fam), 'EX', remainingTtl)
    redis.call('DEL', kActive)
    return {2, ''}
  end
end

-- 4) Lookup exists but token is neither active nor used: invalid (forged or
--    the used tombstone already expired while family still alive — treat as
--    invalid; client re-authenticates). Unified INVALID per V1.
return {4, ''}
