// Instagram Platform Posting Tool — wires agent to postContent() service
// Routes through distribution-scheduler for rate-limited, staggered posting.

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { db } from "@/lib/db";
import { scheduleDistribution } from "@/server/services/distribution-scheduler";

// ── Schedule Instagram Post Tool ──────────────────────────────

export const scheduleInstagramPost = createTool({
  id: "scheduleInstagramPost",
  description:
    "Schedule a post to Instagram via the distribution pipeline. Creates PostRecord(s) and enqueues for post-worker. Supports Reels and carousel posts.",
  inputSchema: z.object({
    organizationId: z.string().describe("Organization ID"),
    variationId: z.string().describe("VideoVariation ID to post"),
    caption: z.string().optional().describe("Override caption (default: use variation caption)"),
  }),
  execute: async (executionContext) => {
    const { organizationId, variationId, caption } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: {
        organizationId: string;
        variationId: string;
        caption?: string;
      }) => {
        // Validate variation exists
        const variation = await db.videoVariation.findUnique({
          where: { id: input.variationId },
          select: { id: true, r2StorageKey: true, caption: true },
        });

        if (!variation) {
          return { scheduled: false, error: "Variation not found" };
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
          ["INSTAGRAM"],
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
      { agentName: "instagram-main", toolName: "scheduleInstagramPost" },
    );
    return wrappedFn({ organizationId, variationId, caption });
  },
});

// ── Get Post Status Tool ──────────────────────────────────────

export const getInstagramPostStatus = createTool({
  id: "getInstagramPostStatus",
  description: "Check the status of a scheduled Instagram post by PostRecord ID",
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
      { agentName: "instagram-main", toolName: "getInstagramPostStatus" },
    );
    return wrappedFn({ postRecordId });
  },
});
