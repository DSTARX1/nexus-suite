import type { Redis } from "ioredis";

/**
 * Token-bucket rate limiter per domain, backed by Redis.
 * Lua script ensures atomic token consumption.
 */

interface DomainConfig {
  tokens: number;
  intervalMs: number;
}

const DEFAULT_CONFIG: DomainConfig = { tokens: 10, intervalMs: 60_000 };

const LUA_CONSUME = `
local key = KEYS[1]
local maxTokens = tonumber(ARGV[1])
local intervalMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil then
  tokens = maxTokens
  lastRefill = now
end

local elapsed = now - lastRefill
local refill = math.floor(elapsed * maxTokens / intervalMs)
if refill > 0 then
  tokens = math.min(maxTokens, tokens + refill)
  lastRefill = now
end

if tokens > 0 then
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
  redis.call('PEXPIRE', key, intervalMs * 2)
  return 1
end

redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
redis.call('PEXPIRE', key, intervalMs * 2)
return 0
`;

export class RateLimiter {
  private redis: Redis;
  private domainConfigs: Map<string, DomainConfig> = new Map();

  constructor(redis: Redis) {
    this.redis = redis;
  }

  setDomainConfig(domain: string, config: DomainConfig): void {
    this.domainConfigs.set(domain, config);
  }

  private getConfig(domain: string): DomainConfig {
    return this.domainConfigs.get(domain) ?? DEFAULT_CONFIG;
  }

  /**
   * Acquire a token for the given domain.
   * Blocks (polls) until a token is available.
   */
  async acquireToken(domain: string): Promise<void> {
    const key = `scraper:ratelimit:${domain}`;
    const config = this.getConfig(domain);

    while (true) {
      const result = await this.redis.eval(
        LUA_CONSUME,
        1,
        key,
        config.tokens,
        config.intervalMs,
        Date.now(),
      );

      if (result === 1) return;

      // Wait before retrying — backoff proportional to interval
      const waitMs = Math.min(config.intervalMs / config.tokens, 5_000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
