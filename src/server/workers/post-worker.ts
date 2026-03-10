import PgBoss from "pg-boss";
import { Redis } from "ioredis";
import { postContent } from "@/server/services/posting";
import { db } from "@/lib/db";
import type { Platform } from "@prisma/client";

// ── Types ─────────────────────────────────────────────────────

interface PostTaskPayload {
  orgId: string;
  accountId: string;
  variationId: string;
  platform: Platform;
  postRecordId: string;
}

// ── Per-platform rate limits (posts per hour) ─────────────────

const PLATFORM_HOURLY_LIMITS: Record<string, number> = {
  TIKTOK: 5,
  INSTAGRAM: 5,
  YOUTUBE: 10,
  X: 15,
  FACEBOOK: 10,
  LINKEDIN: 5,
};

const RATE_KEY_PREFIX = "post:rate";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0");

async function checkPlatformRateLimit(
  orgId: string,
  platform: string,
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const limit = PLATFORM_HOURLY_LIMITS[platform] ?? 5;
  const key = `${RATE_KEY_PREFIX}:${orgId}:${platform}`;
  const current = await redis.get(key);
  const used = current ? parseInt(current, 10) : 0;

  return { allowed: used < limit, current: used, limit };
}

async function incrementPlatformRate(orgId: string, platform: string): Promise<void> {
  const key = `${RATE_KEY_PREFIX}:${orgId}:${platform}`;
  const pipeline = redis.pipeline();
  pipeline.incr(key);
  pipeline.expire(key, 3600); // 1 hour TTL
  await pipeline.exec();
}

// ── Worker ────────────────────────────────────────────────────

const QUEUE_NAME = "post:task";
const SCHEDULE_POLL_QUEUE = "post:schedule-poll";
const SCHEDULE_POLL_CRON = "* * * * *"; // every minute

let boss: PgBoss | null = null;

async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss(process.env.DATABASE_URL!);
    await boss.start();
  }
  return boss;
}

export async function startPostWorker(): Promise<void> {
  const b = await getBoss();

  // ── Main post execution worker ──────────────────────────────
  await b.work<PostTaskPayload>(
    QUEUE_NAME,
    { batchSize: 2 },
    async ([job]) => {
      const { orgId, accountId, variationId, platform, postRecordId } = job.data;

      // Verify PostRecord still exists and is SCHEDULED
      const record = await db.postRecord.findUnique({
        where: { id: postRecordId },
        select: { status: true, scheduledAt: true },
      });

      if (!record) return;
      if (record.status !== "SCHEDULED") return;

      // Respect per-platform rate limits
      const rateCheck = await checkPlatformRateLimit(orgId, platform);
      if (!rateCheck.allowed) {
        // Re-enqueue with a 5-minute delay instead of failing
        await b.send(QUEUE_NAME, job.data, {
          startAfter: new Date(Date.now() + 5 * 60 * 1000),
        });
        return;
      }

      await postContent(orgId, accountId, variationId, platform, postRecordId);
      await incrementPlatformRate(orgId, platform);
    },
  );

  // ── Schedule poll: picks up future-dated SCHEDULED posts ────
  await b.schedule(SCHEDULE_POLL_QUEUE, SCHEDULE_POLL_CRON, {});

  await b.work(
    SCHEDULE_POLL_QUEUE,
    { batchSize: 1 },
    async () => {
      // Find posts that are SCHEDULED and past their scheduledAt but not yet queued
      // pg-boss startAfter handles this natively, but this catches any orphans
      const overdueRecords = await db.postRecord.findMany({
        where: {
          status: "SCHEDULED",
          scheduledAt: { lte: new Date() },
        },
        take: 20,
        orderBy: { scheduledAt: "asc" },
        select: {
          id: true,
          organizationId: true,
          accountId: true,
          variationId: true,
          platform: true,
        },
      });

      for (const record of overdueRecords) {
        // Try to enqueue — pg-boss deduplicates via singletonKey
        await b.send(
          QUEUE_NAME,
          {
            orgId: record.organizationId,
            accountId: record.accountId,
            variationId: record.variationId,
            platform: record.platform,
            postRecordId: record.id,
          },
          { singletonKey: `post:${record.id}` },
        );
      }
    },
  );
}

export async function enqueuePost(
  payload: PostTaskPayload,
  scheduledAt?: Date,
): Promise<string | null> {
  const b = await getBoss();
  return b.send(QUEUE_NAME, payload, {
    ...(scheduledAt ? { startAfter: scheduledAt } : {}),
    singletonKey: `post:${payload.postRecordId}`,
  });
}

export async function stopPostWorker(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
  }
  await redis.quit();
}
