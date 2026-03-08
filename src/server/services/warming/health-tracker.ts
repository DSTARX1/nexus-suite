import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0");

const HEALTH_PREFIX = "session:health:";
const STALE_THRESHOLD_DAYS = 7;

interface HealthEntry {
  lastActionAt: string; // ISO timestamp
  actionCount: number;
  phase: number; // current warming phase (1-4)
}

export async function recordAction(accountId: string, phase: number): Promise<void> {
  const key = `${HEALTH_PREFIX}${accountId}`;
  const entry: HealthEntry = {
    lastActionAt: new Date().toISOString(),
    actionCount: await getActionCount(accountId) + 1,
    phase,
  };
  // TTL 30 days — auto-cleanup for abandoned accounts
  await redis.set(key, JSON.stringify(entry), "EX", 30 * 86400);
}

export async function getHealth(accountId: string): Promise<HealthEntry | null> {
  const raw = await redis.get(`${HEALTH_PREFIX}${accountId}`);
  if (!raw) return null;
  return JSON.parse(raw) as HealthEntry;
}

export async function isStale(accountId: string): Promise<boolean> {
  const health = await getHealth(accountId);
  if (!health) return true;

  const lastAction = new Date(health.lastActionAt).getTime();
  const threshold = Date.now() - STALE_THRESHOLD_DAYS * 86400 * 1000;
  return lastAction < threshold;
}

export async function flagStale(accountId: string): Promise<void> {
  const key = `${HEALTH_PREFIX}${accountId}:stale`;
  await redis.set(key, "1", "EX", 30 * 86400);
}

export async function isMarkedStale(accountId: string): Promise<boolean> {
  return (await redis.exists(`${HEALTH_PREFIX}${accountId}:stale`)) === 1;
}

export async function clearStale(accountId: string): Promise<void> {
  await redis.del(`${HEALTH_PREFIX}${accountId}:stale`);
}

async function getActionCount(accountId: string): Promise<number> {
  const health = await getHealth(accountId);
  return health?.actionCount ?? 0;
}

export { redis as warmingRedis };
