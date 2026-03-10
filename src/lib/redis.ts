import Redis from "ioredis";

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379/0";
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
}

const globalForRedis = globalThis as unknown as { redis: Redis | undefined };

export const redis = globalForRedis.redis ?? createRedisClient();

if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;
