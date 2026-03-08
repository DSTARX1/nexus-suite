import type { Redis } from "ioredis";

const CF_COOKIE_TTL = 1800; // 30 minutes

interface CachedCookies {
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  userAgent: string;
}

/**
 * CF cookie cache — stores solved Cloudflare cookies in Redis
 * so subsequent requests to the same domain skip the challenge.
 */
export class CookieCache {
  private redis: Redis;
  private ttl: number;

  constructor(redis: Redis, ttl?: number) {
    this.redis = redis;
    this.ttl = ttl ?? CF_COOKIE_TTL;
  }

  private key(domain: string): string {
    return `scraper:cf:${domain}`;
  }

  async get(domain: string): Promise<CachedCookies | null> {
    const raw = await this.redis.get(this.key(domain));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as CachedCookies;
    } catch {
      return null;
    }
  }

  async set(domain: string, data: CachedCookies): Promise<void> {
    await this.redis.set(
      this.key(domain),
      JSON.stringify(data),
      "EX",
      this.ttl,
    );
  }

  async invalidate(domain: string): Promise<void> {
    await this.redis.del(this.key(domain));
  }
}
