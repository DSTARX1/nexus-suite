// Trend Scout — Tier 3 shared specialist
// Monitors trending topics across platforms for content opportunities.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";

const searchTrends = createTool({
  id: "tavilySearch",
  description: "Search for trending topics and viral content patterns",
  inputSchema: z.object({
    query: z.string().describe("Search query for trends"),
    platform: z.string().optional().describe("Filter by platform (youtube, tiktok, etc.)"),
  }),
  execute: async (executionContext) => {
    const { query, platform } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { query: string; platform?: string }) => ({
        query: input.query,
        platform: input.platform ?? "all",
        trends: [] as string[],
        status: "pending-integration" as const,
      }),
      { agentName: "trend-scout", toolName: "tavilySearch" },
    );
    return wrappedFn({ query, platform });
  },
});

export const trendScoutAgent = new Agent({
  name: "trend-scout",
  instructions: `You are the Trend Scout specialist. Your role is to identify trending topics, viral patterns, and content opportunities across platforms.

You can search for:
- Trending hashtags and topics
- Viral content patterns and formats
- Emerging niches and content gaps
- Competitor content performance signals

Return concise, actionable trend insights. Focus on timeliness and relevance to the creator's niche.`,
  model: modelConfig.tier25,
  tools: { searchTrends },
});
