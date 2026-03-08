import type PgBoss from "pg-boss";
import { db } from "@/lib/db";
import type { ContentScheduleJob } from "../types.js";
import type { Platform } from "@prisma/client";

export async function handleContentSchedule(
  boss: PgBoss,
  job: PgBoss.Job<ContentScheduleJob>,
): Promise<void> {
  const { contentId, scheduledAt, organizationId } = job.data;
  const scheduleDate = new Date(scheduledAt);

  // Resolve content — contentId is a SourceVideo id
  const sourceVideo = await db.sourceVideo.findUnique({
    where: { id: contentId },
    include: {
      variations: {
        where: { status: "ready" },
        select: { id: true },
      },
    },
  });

  if (!sourceVideo) {
    console.error(`[content-schedule] source video not found: ${contentId}`);
    return;
  }

  if (sourceVideo.variations.length === 0) {
    console.error(`[content-schedule] no ready variations for content: ${contentId}`);
    return;
  }

  const variation = sourceVideo.variations[0]!;

  // Find all accounts for this org (schedule across all available platforms)
  const accounts = await db.orgPlatformToken.findMany({
    where: {
      organizationId,
      circuitState: { not: "OPEN" },
    },
    select: { id: true, platform: true },
  });

  if (accounts.length === 0) {
    console.error(`[content-schedule] no eligible accounts for org: ${organizationId}`);
    return;
  }

  for (const account of accounts) {
    // Create PostRecord with scheduledAt
    const postRecord = await db.postRecord.create({
      data: {
        organizationId,
        accountId: account.id,
        variationId: variation.id,
        platform: account.platform,
        scheduledAt: scheduleDate,
        status: "SCHEDULED",
      },
    });

    // Enqueue post:task with startAfter — same pattern as distribution-scheduler
    await boss.send(
      "post:task",
      {
        orgId: organizationId,
        accountId: account.id,
        variationId: variation.id,
        platform: account.platform as Platform,
        postRecordId: postRecord.id,
      },
      { startAfter: scheduleDate },
    );
  }
}
