/**
 * The Lua scripts. This file is why the package exists.
 *
 * Redis executes a script as ONE unit: no other client's command interleaves
 * between its first and last line. That is the entire atomicity guarantee, and
 * it is available in no other way here — Redis has no compare-and-swap for a
 * hash field, and WATCH/MULTI would turn every contended take into a retry loop
 * whose failure rate rises with the concurrency it is supposed to survive.
 *
 * The rule this file lives by: a primitive's read, its arithmetic and its write
 * are in the same script. The moment they are three round trips, two processes
 * can both read `tokens = 1`, both decide "yes", and both write `tokens = 0` —
 * a limit of 10 admits 11, then 20, then however many replicas are running.
 * `test/mutation.test.ts` splits these scripts back into three commands and
 * asserts the concurrency suite goes red, so the claim on this comment is
 * checked by CI rather than believed.
 *
 * Every script is a pure function of KEYS, ARGV and the stored state. None of
 * them calls `redis.call('TIME')`: the clock is passed in as ARGV. A script
 * that read the server clock would be non-deterministic, which historically
 * made replication unsafe and still makes a test unable to advance time without
 * sleeping.
 */

/**
 * Token bucket (M19).
 *
 * KEYS[1] the bucket hash: fields `t` (tokens, fractional) and `ts` (last refill ms)
 * ARGV[1] capacity          ARGV[2] refill tokens per second
 * ARGV[3] now (ms)          ARGV[4] cost      ARGV[5] ttl (seconds)
 *
 * Returns {allowed, waitMs, tokensLeftMilli}. `waitMs` is what the caller
 * sleeps before retrying; it is computed here rather than by the caller because
 * only the script knows the post-refill token count.
 *
 * The third element is scaled by 1000 and floored: RESP2 integers are the only
 * numeric type a Lua script can return (a float is truncated silently), and a
 * test that asserts on fractional tokens needs to see them.
 */
export const TOKEN_BUCKET_LUA = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refill    = tonumber(ARGV[2])
local now       = tonumber(ARGV[3])
local cost      = tonumber(ARGV[4])
local ttl       = tonumber(ARGV[5])

local state  = redis.call('HMGET', key, 't', 'ts')
local tokens = tonumber(state[1])
local last   = tonumber(state[2])

-- A bucket nobody has touched starts full. The alternative, starting empty,
-- would make the first request after every idle period wait for a refill.
if tokens == nil or last == nil then
  tokens = capacity
  last   = now
end

-- A clock that went backwards (NTP step, or a caller passing a stale
-- timestamp) must not mint tokens. max(0, ...) makes the refill monotonic.
local elapsed = now - last
if elapsed < 0 then elapsed = 0 end

tokens = math.min(capacity, tokens + (elapsed / 1000.0) * refill)

local allowed = 0
local wait    = 0
if tokens >= cost then
  tokens  = tokens - cost
  allowed = 1
else
  -- Ceiling: rounding down would wake the caller a fraction early, it would
  -- fail again, and a busy loop would replace the wait.
  wait = math.ceil(((cost - tokens) / refill) * 1000)
end

redis.call('HSET', key, 't', tokens, 'ts', now)
-- Refreshed on every take: an idle bucket is indistinguishable from a full one,
-- so letting it expire costs nothing and stops abandoned keys accumulating.
redis.call('EXPIRE', key, ttl)

return {allowed, wait, math.floor(tokens * 1000)}
`;

/**
 * Capacity semaphore — acquire.
 *
 * KEYS[1] a sorted set: member = holder token, score = expiry (ms)
 * ARGV[1] now (ms)   ARGV[2] capacity   ARGV[3] token   ARGV[4] lease ms
 *
 * Returns {granted, holdersAfter, expiresAtMs}.
 *
 * The sorted set is what makes the TTL work. A counter (INCR/DECR) cannot
 * expire ONE holder — if a process dies holding a permit, its increment is
 * indistinguishable from a live one and the count never comes back down. With
 * a zset keyed by expiry, every acquire first drops the members whose lease has
 * run out, so a crashed holder's permit returns to the pool on its own, without
 * a reaper process that would itself need to be highly available.
 */
export const SEMAPHORE_ACQUIRE_LUA = `
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local token    = ARGV[3]
local leaseMs  = tonumber(ARGV[4])

-- Expired holders first, and inside the same atomic unit: doing this as a
-- separate command would let another client see the stale count.
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

-- Re-acquiring with a token already held is a renewal, not a second permit.
-- Counting it twice is how a retried activity silently doubles the capacity.
local held = redis.call('ZSCORE', key, token)
if held then
  local expiry = now + leaseMs
  redis.call('ZADD', key, expiry, token)
  redis.call('PEXPIRE', key, leaseMs)
  return {1, redis.call('ZCARD', key), expiry}
end

local count = redis.call('ZCARD', key)
if count >= capacity then
  return {0, count, 0}
end

local expiry = now + leaseMs
redis.call('ZADD', key, expiry, token)
-- The key's own TTL tracks the longest lease in it, so an entirely abandoned
-- semaphore disappears rather than lingering as an empty zset forever.
redis.call('PEXPIRE', key, leaseMs)
return {1, count + 1, expiry}
`;

/**
 * Capacity semaphore — release.
 *
 * KEYS[1] the zset   ARGV[1] token
 * Returns {released, holdersAfter}.
 *
 * `released = 0` means the token was not there — its lease expired and the
 * permit was already reclaimed. The caller is told rather than ignored: work
 * that outran its lease has been running without a permit, which is a real
 * over-subscription and not something to swallow.
 */
export const SEMAPHORE_RELEASE_LUA = `
local key   = KEYS[1]
local token = ARGV[1]
local removed = redis.call('ZREM', key, token)
return {removed, redis.call('ZCARD', key)}
`;

/**
 * Capacity semaphore — renew.
 *
 * KEYS[1] the zset   ARGV[1] now (ms)   ARGV[2] token   ARGV[3] lease ms
 * Returns {renewed, expiresAtMs}.
 *
 * Renewal is what lets the lease be SHORT. A lease sized for the longest
 * possible job (a 40-minute sandbox) would leave a crashed holder's permit
 * stranded for 40 minutes; a 30-second lease that the holder heartbeats
 * recovers in 30.
 *
 * The refusal to resurrect an expired permit is carried by the two lines
 * BEFORE the write, and by them alone. `ZREMRANGEBYSCORE ... '-inf', now` is
 * inclusive of `now`, so every member whose expiry has arrived is gone before
 * `ZSCORE` looks; a token that survives to the `ZSCORE` is therefore live, and
 * one that does not returns `{0, 0}` here.
 *
 * This carried a `ZADD ... XX` for a while, described in this comment as "the
 * load-bearing flag". It was not load-bearing — it was unreachable. By the
 * time control reaches the write, `ZSCORE` has already proved the member
 * exists, so `XX` ("only update an existing member") can never change the
 * outcome. Removing it changed no test, which is the same thing as saying it
 * never decided anything. It is gone, and the guard that does the work is
 * named here instead: a comment that credits the wrong line teaches the next
 * reader to protect the wrong line.
 */
export const SEMAPHORE_RENEW_LUA = `
local key     = KEYS[1]
local now     = tonumber(ARGV[1])
local token   = ARGV[2]
local leaseMs = tonumber(ARGV[3])

-- Inclusive of now: a permit whose lease has just arrived is already expired.
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZSCORE', key, token) == false then
  return {0, 0}
end
local expiry = now + leaseMs
redis.call('ZADD', key, expiry, token)
redis.call('PEXPIRE', key, leaseMs)
return {1, expiry}
`;

/**
 * Distributed lock — release, and renew.
 *
 * Acquire needs no script: `SET key token NX PX ttl` is already atomic.
 * Release does — "read the owner, compare, delete" as three commands has a
 * window in which the lock expires and another process takes it between the
 * read and the delete, and the first process then deletes a lock it no longer
 * owns. That is the classic mistake this comment exists to prevent.
 *
 * KEYS[1] the lock key   ARGV[1] the fencing token   (renew: ARGV[2] ttl ms)
 */
export const LOCK_RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export const LOCK_RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
