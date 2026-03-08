import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0");

const HEALTH_PREFIX = "session:health:";
const STALE_THRESHOLD_DAYS = 7;

interface HealthEntry {
  lastActionAt: string; // ISO timestamp
  actionCount: number;
  phase: number; // current warming phase (1-4)
  verificationCount: number;
  lastVerifiedAt: string | null;
  verificationFailures: number;
}

export async function recordAction(accountId: string, phase: number): Promise<void> {
  const key = `${HEALTH_PREFIX}${accountId}`;
  const existing = await getHealth(accountId);
  const entry: HealthEntry = {
    lastActionAt: new Date().toISOString(),
    actionCount: (existing?.actionCount ?? 0) + 1,
    phase,
    verificationCount: existing?.verificationCount ?? 0,
    lastVerifiedAt: existing?.lastVerifiedAt ?? null,
    verificationFailures: existing?.verificationFailures ?? 0,
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

export async function recordVerification(accountId: string, success: boolean): Promise<void> {
  const key = `${HEALTH_PREFIX}${accountId}`;
  const existing = await getHealth(accountId);
  const entry: HealthEntry = {
    lastActionAt: existing?.lastActionAt ?? new Date().toISOString(),
    actionCount: existing?.actionCount ?? 0,
    phase: existing?.phase ?? 1,
    verificationCount: (existing?.verificationCount ?? 0) + 1,
    lastVerifiedAt: new Date().toISOString(),
    verificationFailures: (existing?.verificationFailures ?? 0) + (success ? 0 : 1),
  };
  await redis.set(key, JSON.stringify(entry), "EX", 30 * 86400);
}

export { redis as warmingRedis };
