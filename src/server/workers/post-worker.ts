import PgBoss from "pg-boss";
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

// ── Worker ────────────────────────────────────────────────────

const QUEUE_NAME = "post:task";

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

  await b.work<PostTaskPayload>(
    QUEUE_NAME,
    { batchSize: 2 },
    async ([job]) => {
      const { orgId, accountId, variationId, platform, postRecordId } = job.data;

      // Verify PostRecord still exists and is SCHEDULED
      const record = await db.postRecord.findUnique({
        where: { id: postRecordId },
        select: { status: true },
      });

      if (!record) return;
      if (record.status !== "SCHEDULED") return;

      await postContent(orgId, accountId, variationId, platform, postRecordId);
    },
  );
}

export async function stopPostWorker(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
  }
}
