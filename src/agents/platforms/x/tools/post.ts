// X Platform Posting Tool — wires agent to postContent() service
// Supports single tweet and thread posting via the scheduling pipeline.

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { db } from "@/lib/db";
import { scheduleDistribution } from "@/server/services/distribution-scheduler";
import { postThread, splitIntoThreadChunks, type XOAuthCredentials } from "@/lib/x-api";

// ── Schedule X Post Tool ──────────────────────────────────────

export const scheduleXPost = createTool({
  id: "scheduleXPost",
  description:
    "Schedule a post to X (Twitter) via the distribution pipeline. Creates a PostRecord and enqueues it for the post-worker.",
  inputSchema: z.object({
    organizationId: z.string().describe("Organization ID"),
    variationId: z.string().describe("VideoVariation ID to post"),
    scheduledAt: z.string().optional().describe("ISO8601 schedule time (default: now)"),
  }),
  execute: async (executionContext) => {
    const { organizationId, variationId, scheduledAt } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: {
        organizationId: string;
        variationId: string;
        scheduledAt?: string;
      }) => {
        // Validate variation exists
        const variation = await db.videoVariation.findUnique({
          where: { id: input.variationId },
          select: { id: true, r2StorageKey: true, caption: true },
        });

        if (!variation) {
          return { scheduled: false, error: "Variation not found" };
        }

        const result = await scheduleDistribution(
          input.organizationId,
          input.variationId,
          ["X"],
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
      { agentName: "x-main", toolName: "scheduleXPost" },
    );
    return wrappedFn({ organizationId, variationId, scheduledAt });
  },
});

// ── Post X Thread Tool ────────────────────────────────────────

export const postXThread = createTool({
  id: "postXThread",
  description:
    "Post a thread of tweets to X. Splits content at sentence boundaries into 280-char chunks and chain-posts.",
  inputSchema: z.object({
    content: z.string().describe("Long-form content to split into a thread"),
    numbered: z.boolean().optional().describe("Add 1/N numbering to tweets"),
    oauthCredentials: z
      .object({
        apiKey: z.string(),
        apiSecret: z.string(),
        accessToken: z.string(),
        accessTokenSecret: z.string(),
      })
      .describe("X OAuth 1.0a credentials"),
  }),
  execute: async (executionContext) => {
    const { content, numbered, oauthCredentials } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: {
        content: string;
        numbered?: boolean;
        oauthCredentials: XOAuthCredentials;
      }) => {
        const chunks = splitIntoThreadChunks(input.content, {
          numbered: input.numbered,
        });

        if (chunks.length === 0) {
          return { posted: false, error: "No content to post" };
        }

        const tweetIds = await postThread(chunks, input.oauthCredentials);
        return {
          posted: true,
          tweetCount: tweetIds.length,
          tweetIds,
          chunks,
        };
      },
      { agentName: "x-main", toolName: "postXThread" },
    );
    return wrappedFn({ content, numbered, oauthCredentials });
  },
});
