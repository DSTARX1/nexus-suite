import PgBoss from "pg-boss";
import { db } from "@/lib/db";
import { canPost } from "./circuit-breaker";
import type { Platform } from "@prisma/client";

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_DAILY_CAPS: Record<string, number> = {
  TIKTOK: 3,
  INSTAGRAM: 2,
  YOUTUBE: 5, // Shorts
};

const BASE_INTERVAL_MIN = 30; // minutes
const BASE_INTERVAL_MAX = 120;
const JITTER_MINUTES = 15;
const SKIP_PROBABILITY = 0.1;

// ── pg-boss singleton ────────────────────────────────────────────

let bossInstance: PgBoss | null = null;

async function getBoss(): Promise<PgBoss> {
  if (!bossInstance) {
    bossInstance = new PgBoss(process.env.DATABASE_URL!);
    await bossInstance.start();
  }
  return bossInstance;
}

// ── Helpers ──────────────────────────────────────────────────────

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function todayRange(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}

async function getOrgDailyCaps(
  orgId: string,
): Promise<Record<string, number>> {
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { brandConfig: true },
  });

  const overrides =
    org?.brandConfig &&
    typeof org.brandConfig === "object" &&
    !Array.isArray(org.brandConfig) &&
    (org.brandConfig as Record<string, unknown>).dailyCaps
      ? ((org.brandConfig as Record<string, unknown>).dailyCaps as Record<string, number>)
      : {};

  return { ...DEFAULT_DAILY_CAPS, ...overrides };
}

// ── Main entry ───────────────────────────────────────────────────

export interface ScheduleResult {
  scheduled: number;
  skipped: number;
  details: Array<{
    accountId: string;
    platform: Platform;
    scheduledAt: Date;
    postRecordId: string;
    skippedByProbability: boolean;
  }>;
}

export async function scheduleDistribution(
  orgId: string,
  variationId: string,
  targetPlatforms: Platform[],
): Promise<ScheduleResult> {
  const boss = await getBoss();
  const dailyCaps = await getOrgDailyCaps(orgId);
  const { start: todayStart, end: todayEnd } = todayRange();

  // Query eligible accounts: CLOSED or HALF_OPEN circuit, sorted by healthScore DESC
  const accounts = await db.orgPlatformToken.findMany({
    where: {
      organizationId: orgId,
      platform: { in: targetPlatforms },
      circuitState: { not: "OPEN" },
    },
    orderBy: { healthScore: "desc" },
  });

  // Count today's posts per account
  const todayPostCounts = await db.postRecord.groupBy({
    by: ["accountId"],
    where: {
      organizationId: orgId,
      scheduledAt: { gte: todayStart, lt: todayEnd },
      status: { in: ["SCHEDULED", "POSTING", "SUCCESS"] },
    },
    _count: { id: true },
  });

  const postCountMap = new Map(
    todayPostCounts.map((r) => [r.accountId, r._count.id]),
  );

  const result: ScheduleResult = { scheduled: 0, skipped: 0, details: [] };
  let slotOffset = 0;

  for (const account of accounts) {
    const cap = dailyCaps[account.platform] ?? 3;
    const currentCount = postCountMap.get(account.id) ?? 0;

    if (currentCount >= cap) continue;

    // Check circuit breaker
    const circuitCheck = await canPost(account.id);
    if (!circuitCheck.allowed) continue;

    // Skip probability — organic behavior mimicry
    const skippedByProbability = Math.random() < SKIP_PROBABILITY;
    if (skippedByProbability) {
      result.skipped++;
      result.details.push({
        accountId: account.id,
        platform: account.platform,
        scheduledAt: new Date(),
        postRecordId: "",
        skippedByProbability: true,
      });
      continue;
    }

    // Calculate staggered time: base interval + jitter
    const intervalMinutes = randomBetween(BASE_INTERVAL_MIN, BASE_INTERVAL_MAX);
    const jitter = randomBetween(-JITTER_MINUTES, JITTER_MINUTES);
    slotOffset += intervalMinutes + jitter;

    const scheduledAt = new Date(Date.now() + slotOffset * 60000);

    // Create PostRecord
    const postRecord = await db.postRecord.create({
      data: {
        organizationId: orgId,
        accountId: account.id,
        variationId,
        platform: account.platform,
        scheduledAt,
        status: "SCHEDULED",
      },
    });

    // Enqueue pg-boss job
    const payload = {
      orgId,
      accountId: account.id,
      variationId,
      platform: account.platform,
      postRecordId: postRecord.id,
    };

    await boss.send("post:task", payload, { startAfter: scheduledAt });

    result.scheduled++;
    result.details.push({
      accountId: account.id,
      platform: account.platform,
      scheduledAt,
      postRecordId: postRecord.id,
      skippedByProbability: false,
    });
  }

  return result;
}
