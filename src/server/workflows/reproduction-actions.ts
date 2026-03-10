// Reproduction pipeline action handlers.
// Registers actions used by competitor-monitor.yaml reproduction steps:
//   reproduction.markAnalyzed — stores analysis on TrackedPost
//   reproduction.enqueueMedia  — sends a download+transform job to media-engine
//   reproduction.schedule      — creates a PostRecord for the reproduced content
//   reproduction.markReproduced — flags the source TrackedPost as reproduced

import PgBoss from "pg-boss";
import { db } from "@/lib/db.js";
import { registerAction, type ActionHandler } from "./executor.js";
import type { WorkflowContext } from "./control-flow.js";

const MEDIA_QUEUE = "media:task";

// ── Action: reproduction.markAnalyzed ────────────────────────────

const markAnalyzed: ActionHandler = async (
  params: Record<string, unknown>,
) => {
  const postId = params.postId as string;
  const analysis = params.analysis as Record<string, unknown>;

  if (!postId) throw new Error("reproduction.markAnalyzed: postId required");

  await db.trackedPost.update({
    where: { id: postId },
    data: {
      analysis: (analysis ?? {}) as import("@prisma/client").Prisma.InputJsonValue,
      analyzedAt: new Date(),
    },
  });

  return { postId, analyzedAt: new Date().toISOString() };
};

// ── Action: reproduction.enqueueMedia ────────────────────────────

let boss: PgBoss | null = null;

async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss(process.env.DATABASE_URL!);
    await boss.start();
  }
  return boss;
}

const enqueueMedia: ActionHandler = async (
  params: Record<string, unknown>,
  context: WorkflowContext,
) => {
  const sourceUrl = params.sourceUrl as string;
  const organizationId =
    (params.organizationId as string) ?? context.organizationId;
  const transforms = params.transforms as Record<string, unknown> | undefined;

  if (!sourceUrl) throw new Error("reproduction.enqueueMedia: sourceUrl required");

  const b = await getBoss();

  // Step 1: Enqueue download
  const downloadJobId = await b.send(MEDIA_QUEUE, {
    type: "download",
    organizationId,
    sourceUrl,
    outputKey: `repro/${organizationId}/${Date.now()}/source`,
  });

  // Step 2: If transforms provided, enqueue transform after download
  let transformJobId: string | null = null;
  if (transforms) {
    transformJobId = await b.send(MEDIA_QUEUE, {
      type: "transform",
      organizationId,
      outputKey: `repro/${organizationId}/${Date.now()}/output`,
      transforms,
    });
  }

  return {
    downloadJobId,
    transformJobId,
    sourceUrl,
    organizationId,
  };
};

// ── Action: reproduction.schedule ────────────────────────────────

const schedule: ActionHandler = async (
  params: Record<string, unknown>,
  context: WorkflowContext,
) => {
  const organizationId =
    (params.organizationId as string) ?? context.organizationId;
  const platform = params.platform as string;
  const caption = params.caption as string | undefined;
  const script = params.script as string | undefined;
  const sourcePostId = params.sourcePostId as string | undefined;

  if (!platform) throw new Error("reproduction.schedule: platform required");

  // Find a healthy platform token for this org+platform
  const token = await db.orgPlatformToken.findFirst({
    where: {
      organizationId,
      platform: platform.toUpperCase() as "TIKTOK" | "INSTAGRAM" | "YOUTUBE" | "X",
      circuitState: "CLOSED",
    },
    select: { id: true },
  });

  if (!token) {
    return {
      scheduled: false,
      reason: `No active ${platform} token found for org ${organizationId}`,
    };
  }

  // Find or create a source video + variation for this reproduction
  const sourceVideo = await db.sourceVideo.create({
    data: {
      organizationId,
      url: (params.sourceUrl as string) ?? "reproduction://generated",
      platform: platform.toUpperCase() as "TIKTOK" | "INSTAGRAM" | "YOUTUBE" | "X",
      metadata: {
        reproduction: true,
        sourcePostId,
        script: script ?? null,
      },
    },
  });

  const variation = await db.videoVariation.create({
    data: {
      sourceVideoId: sourceVideo.id,
      variationIndex: 0,
      transforms: {},
      caption: caption ?? null,
      status: "pending",
    },
  });

  const record = await db.postRecord.create({
    data: {
      organizationId,
      accountId: token.id,
      variationId: variation.id,
      platform: platform.toUpperCase() as "TIKTOK" | "INSTAGRAM" | "YOUTUBE" | "X",
      scheduledAt: new Date(Date.now() + 30 * 60_000), // 30 min from now
      caption: caption ?? null,
    },
  });

  return {
    scheduled: true,
    postRecordId: record.id,
    variationId: variation.id,
    scheduledAt: record.scheduledAt.toISOString(),
  };
};

// ── Action: reproduction.markReproduced ─────────────────────────

const markReproduced: ActionHandler = async (
  params: Record<string, unknown>,
) => {
  const postId = params.postId as string;
  if (!postId) throw new Error("reproduction.markReproduced: postId required");

  await db.trackedPost.update({
    where: { id: postId },
    data: { reproduced: true },
  });

  return { postId, reproduced: true };
};

// ── Action: content.schedule (generic — used by daily-pipeline) ──

const contentSchedule: ActionHandler = async (
  params: Record<string, unknown>,
  context: WorkflowContext,
) => {
  const organizationId =
    (params.organizationId as string) ?? context.organizationId;
  const platform = params.platform as string;
  const caption = params.caption as string | undefined;
  const script = params.script as string | undefined;
  const qualityScore = params.qualityScore as string | undefined;

  if (!platform) throw new Error("content.schedule: platform required");

  const token = await db.orgPlatformToken.findFirst({
    where: {
      organizationId,
      platform: platform.toUpperCase() as "TIKTOK" | "INSTAGRAM" | "YOUTUBE" | "X",
      circuitState: "CLOSED",
    },
    select: { id: true },
  });

  if (!token) {
    return { scheduled: false, reason: `No active ${platform} token` };
  }

  const sourceVideo = await db.sourceVideo.create({
    data: {
      organizationId,
      url: "pipeline://daily",
      platform: platform.toUpperCase() as "TIKTOK" | "INSTAGRAM" | "YOUTUBE" | "X",
      metadata: { script, qualityScore },
    },
  });

  const variation = await db.videoVariation.create({
    data: {
      sourceVideoId: sourceVideo.id,
      variationIndex: 0,
      transforms: {},
      caption: caption ?? null,
      status: "pending",
    },
  });

  const record = await db.postRecord.create({
    data: {
      organizationId,
      accountId: token.id,
      variationId: variation.id,
      platform: platform.toUpperCase() as "TIKTOK" | "INSTAGRAM" | "YOUTUBE" | "X",
      scheduledAt: new Date(Date.now() + 60 * 60_000), // 1 hour from now
      caption: caption ?? null,
    },
  });

  return {
    scheduled: true,
    postRecordId: record.id,
    scheduledAt: record.scheduledAt.toISOString(),
  };
};

// ── Action: content.logSkipped ───────────────────────────────────

const contentLogSkipped: ActionHandler = async (
  params: Record<string, unknown>,
) => {
  const reason = params.reason as string;
  const organizationId = params.organizationId as string;
  console.log(
    `[workflow] content skipped org=${organizationId} reason="${reason}"`,
  );
  return { logged: true, reason };
};

// ── Action: engagement.logSkipped ────────────────────────────────

const engagementLogSkipped: ActionHandler = async (
  params: Record<string, unknown>,
) => {
  const reason = params.reason as string;
  const organizationId = params.organizationId as string;
  const platform = params.platform as string;
  console.log(
    `[workflow] engagement skipped org=${organizationId} platform=${platform} reason="${reason}"`,
  );
  return { logged: true, reason };
};

// ── Action: engagement.compileReport ─────────────────────────────

const engagementCompileReport: ActionHandler = async (
  params: Record<string, unknown>,
) => {
  return {
    compiled: true,
    organizationId: params.organizationId,
    platform: params.platform,
    analyticsIncluded: !!params.analytics,
    responsesIncluded: !!params.responses,
  };
};

// ── Registration ────────────────────────────────────────────────

export function registerReproductionActions(): void {
  registerAction("reproduction.markAnalyzed", markAnalyzed);
  registerAction("reproduction.enqueueMedia", enqueueMedia);
  registerAction("reproduction.schedule", schedule);
  registerAction("reproduction.markReproduced", markReproduced);
  registerAction("content.schedule", contentSchedule);
  registerAction("content.logSkipped", contentLogSkipped);
  registerAction("engagement.logSkipped", engagementLogSkipped);
  registerAction("engagement.compileReport", engagementCompileReport);
}
