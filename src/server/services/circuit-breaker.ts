import { Redis } from "ioredis";
import { db } from "@/lib/db";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0");

// ── Constants ────────────────────────────────────────────────────
const FAILURE_THRESHOLD = 3;
const BASE_COOLDOWN_SECS = 300; // 5 minutes
const COOLDOWN_MULTIPLIER = 3; // 5min → 15min → 45min
const MAX_BACKOFF_LEVEL = 3;
const HEALTH_DECAY = 0.15; // per failure
const HEALTH_RECOVERY = 0.1; // per success
const AUTO_DISABLE_THRESHOLD = 0.3;

// Redis key helpers
function cooldownKey(accountId: string): string {
  return `circuit:cooldown:${accountId}`;
}

function backoffKey(accountId: string): string {
  return `circuit:backoff:${accountId}`;
}

// ── canPost ──────────────────────────────────────────────────────

export interface CanPostResult {
  allowed: boolean;
  reason?: string;
}

export async function canPost(accountId: string): Promise<CanPostResult> {
  const account = await db.orgPlatformToken.findUnique({
    where: { id: accountId },
    select: { circuitState: true, healthScore: true },
  });

  if (!account) {
    return { allowed: false, reason: "Account not found" };
  }

  if (account.circuitState === "CLOSED") {
    return { allowed: true };
  }

  if (account.circuitState === "OPEN") {
    // Check if cooldown has expired → transition to HALF_OPEN
    const cooldownExists = await redis.exists(cooldownKey(accountId));
    if (cooldownExists) {
      const ttl = await redis.ttl(cooldownKey(accountId));
      return { allowed: false, reason: `Circuit OPEN — cooldown ${ttl}s remaining` };
    }

    // Cooldown expired → transition to HALF_OPEN
    await db.orgPlatformToken.update({
      where: { id: accountId },
      data: { circuitState: "HALF_OPEN" },
    });

    return { allowed: true, reason: "Circuit HALF_OPEN — trial request" };
  }

  // HALF_OPEN — allow one trial request
  return { allowed: true, reason: "Circuit HALF_OPEN — trial request" };
}

// ── recordSuccess ────────────────────────────────────────────────

export async function recordSuccess(accountId: string): Promise<void> {
  const account = await db.orgPlatformToken.findUnique({
    where: { id: accountId },
    select: { healthScore: true },
  });

  if (!account) return;

  const newHealth = Math.min(1.0, account.healthScore + HEALTH_RECOVERY);

  await db.orgPlatformToken.update({
    where: { id: accountId },
    data: {
      consecutiveFailures: 0,
      circuitState: "CLOSED",
      healthScore: newHealth,
      lastSuccessAt: new Date(),
    },
  });

  // Reset backoff level on success
  await redis.del(backoffKey(accountId));
  await redis.del(cooldownKey(accountId));
}

// ── recordFailure ────────────────────────────────────────────────

export async function recordFailure(accountId: string): Promise<void> {
  const account = await db.orgPlatformToken.findUnique({
    where: { id: accountId },
    select: {
      consecutiveFailures: true,
      circuitState: true,
      healthScore: true,
      organizationId: true,
      accountLabel: true,
      platform: true,
    },
  });

  if (!account) return;

  const newFailures = account.consecutiveFailures + 1;
  const newHealth = Math.max(0, account.healthScore - HEALTH_DECAY);

  // Determine next circuit state
  let nextState = account.circuitState;

  if (account.circuitState === "HALF_OPEN") {
    // Failed during trial → back to OPEN with escalated backoff
    nextState = "OPEN";
  } else if (account.circuitState === "CLOSED" && newFailures >= FAILURE_THRESHOLD) {
    nextState = "OPEN";
  }

  await db.orgPlatformToken.update({
    where: { id: accountId },
    data: {
      consecutiveFailures: newFailures,
      circuitState: nextState,
      healthScore: newHealth,
      lastFailureAt: new Date(),
    },
  });

  // Set cooldown if transitioning to OPEN
  if (nextState === "OPEN" && account.circuitState !== "OPEN") {
    const backoffLevel = Number(await redis.get(backoffKey(accountId)) ?? 0);
    const cooldownSecs = BASE_COOLDOWN_SECS * Math.pow(COOLDOWN_MULTIPLIER, Math.min(backoffLevel, MAX_BACKOFF_LEVEL));

    await redis.set(cooldownKey(accountId), "1", "EX", Math.round(cooldownSecs));
    await redis.set(backoffKey(accountId), String(backoffLevel + 1), "EX", 86400); // 24h TTL
  }

  // Auto-disable if health critically low
  if (newHealth < AUTO_DISABLE_THRESHOLD) {
    await emitAdminAlert(accountId, account.organizationId, account.accountLabel, account.platform, newHealth);
  }
}

// ── Admin Alert ──────────────────────────────────────────────────

async function emitAdminAlert(
  accountId: string,
  organizationId: string,
  accountLabel: string,
  platform: string,
  healthScore: number,
): Promise<void> {
  const payload = JSON.stringify({
    type: "circuit_breaker:auto_disable",
    accountId,
    organizationId,
    accountLabel,
    platform,
    healthScore,
    timestamp: new Date().toISOString(),
  });

  await redis.publish("admin:alerts", payload);
}
