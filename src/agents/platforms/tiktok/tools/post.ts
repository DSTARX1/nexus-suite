// TikTok Platform Posting Tool — wires agent to postContent() service
// Routes through distribution-scheduler for rate-limited, staggered posting.
// Note: Unaudited apps post as SELF_ONLY per TikTok Content Posting API rules.

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { db } from "@/lib/db";
import { scheduleDistribution } from "@/server/services/distribution-scheduler";

// ── Schedule TikTok Post Tool ─────────────────────────────────

export const scheduleTikTokPost = createTool({
  id: "scheduleTikTokPost",
  description:
    "Schedule a video post to TikTok via the distribution pipeline. Creates PostRecord(s) and enqueues for post-worker.",
  inputSchema: z.object({
    organizationId: z.string().describe("Organization ID"),
    variationId: z.string().describe("VideoVariation ID to post"),
    caption: z.string().optional().describe("Override caption/title (default: use variation caption)"),
  }),
  execute: async (executionContext) => {
    const { organizationId, variationId, caption } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: {
        organizationId: string;
        variationId: string;
        caption?: string;
      }) => {
        // Validate variation exists and has a video file
        const variation = await db.videoVariation.findUnique({
          where: { id: input.variationId },
          select: { id: true, r2StorageKey: true, caption: true },
        });

        if (!variation) {
          return { scheduled: false, error: "Variation not found" };
        }

        if (!variation.r2StorageKey) {
          return {
            scheduled: false,
            error: "Variation has no video file (r2StorageKey is null)",
          };
        }

        // If caption override provided, update variation
        if (input.caption && input.caption !== variation.caption) {
          await db.videoVariation.update({
            where: { id: input.variationId },
            data: { caption: input.caption },
          });
        }

        const result = await scheduleDistribution(
          input.organizationId,
          input.variationId,
          ["TIKTOK"],
        );

        return {
          scheduled: result.scheduled > 0,
          scheduledCount: result.scheduled,
          skippedCount: result.skipped,
          details: result.details.map((d) => ({
            postRecordId: d.postRecordId,
            scheduledAt: d.scheduledAt.toISOString(),
            platform: d.platform,
          })),
        };
      },
      { agentName: "tiktok-main", toolName: "scheduleTikTokPost" },
    );
    return wrappedFn({ organizationId, variationId, caption });
  },
});

// ── Get Post Status Tool ──────────────────────────────────────

export const getTikTokPostStatus = createTool({
  id: "getTikTokPostStatus",
  description: "Check the status of a scheduled TikTok post by PostRecord ID",
  inputSchema: z.object({
    postRecordId: z.string().describe("PostRecord ID to check"),
  }),
  execute: async (executionContext) => {
    const { postRecordId } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { postRecordId: string }) => {
        const record = await db.postRecord.findUnique({
          where: { id: input.postRecordId },
          select: {
            id: true,
            status: true,
            platform: true,
            scheduledAt: true,
            postedAt: true,
            externalPostId: true,
            errorMessage: true,
          },
        });

        if (!record) {
          return { found: false, error: "PostRecord not found" };
        }

        return {
          found: true,
          ...record,
          scheduledAt: record.scheduledAt.toISOString(),
          postedAt: record.postedAt?.toISOString() ?? null,
        };
      },
      { agentName: "tiktok-main", toolName: "getTikTokPostStatus" },
    );
    return wrappedFn({ postRecordId });
  },
});
