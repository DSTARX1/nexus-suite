import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0");

// ── Content Policy ───────────────────────────────────────────────

const BLOCKED_KEYWORDS = [
  "ignore previous instructions",
  "ignore all instructions",
  "disregard your instructions",
  "you are now",
  "act as if",
  "pretend you are",
  "jailbreak",
  "bypass restrictions",
];

export interface ContentCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check agent output against content policy.
 * Keyword blocklist first (fast), optional LLM classification for edge cases.
 */
export function checkContentPolicy(text: string): ContentCheckResult {
  const lower = text.toLowerCase();

  for (const keyword of BLOCKED_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        allowed: false,
        reason: `Blocked keyword detected: "${keyword}"`,
      };
    }
  }

  return { allowed: true };
}

// ── Rate Limiting (Redis sliding window) ─────────────────────────

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 60,
  windowMs: 60_000, // 1 minute
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

/**
 * Per-tool rate limiting via Redis sliding window.
 * Key: safety:ratelimit:{orgId}:{toolName}
 */
export async function checkRateLimit(
  orgId: string,
  toolName: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
): Promise<RateLimitResult> {
  const key = `safety:ratelimit:${orgId}:${toolName}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;

  // Sliding window: sorted set with timestamp as score
  const pipeline = redis.pipeline();
  // Remove entries outside the window
  pipeline.zremrangebyscore(key, 0, windowStart);
  // Count entries in window
  pipeline.zcard(key);
  // Add current request
  pipeline.zadd(key, now.toString(), `${now}:${Math.random()}`);
  // Set TTL to auto-cleanup
  pipeline.pexpire(key, config.windowMs);

  const results = await pipeline.exec();
  // zcard result is at index 1
  const currentCount = (results?.[1]?.[1] as number) ?? 0;

  if (currentCount >= config.maxRequests) {
    // Over limit — remove the entry we just added
    await redis.zremrangebyscore(key, now, now);
    // Get oldest entry to calculate reset time
    const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
    const resetMs = oldest.length >= 2
      ? Number(oldest[1]) + config.windowMs - now
      : config.windowMs;

    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.max(0, resetMs),
    };
  }

  return {
    allowed: true,
    remaining: config.maxRequests - currentCount - 1,
    resetMs: config.windowMs,
  };
}
