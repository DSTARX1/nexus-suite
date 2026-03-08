import type { Redis } from "ioredis";
import type { AgentPool } from "./pool.js";

const ROTATION_THRESHOLD = 50;

/**
 * Fingerprint rotator — tracks task count per context in Redis.
 * After ROTATION_THRESHOLD tasks, triggers context recycling in AgentPool
 * to create a fresh context with a new browser profile.
 */
export class FingerprintRotator {
  private redis: Redis;
  private pool: AgentPool;
  private threshold: number;

  constructor(redis: Redis, pool: AgentPool, threshold?: number) {
    this.redis = redis;
    this.pool = pool;
    this.threshold = threshold ?? ROTATION_THRESHOLD;
  }

  /**
   * Increment task counter for a context. If threshold reached,
   * recycle the context and return true.
   */
  async trackAndRotate(contextId: string): Promise<boolean> {
    const key = `scraper:fp:count:${contextId}`;
    const count = await this.redis.incr(key);

    if (count >= this.threshold) {
      console.log(`[FingerprintRotator] rotating context ${contextId} after ${count} tasks`);
      await this.redis.del(key);
      await this.pool.recycle(contextId);
      return true;
    }

    return false;
  }

  /**
   * Clean up Redis key when a context is manually recycled or removed.
   */
  async resetCounter(contextId: string): Promise<void> {
    await this.redis.del(`scraper:fp:count:${contextId}`);
  }
}
