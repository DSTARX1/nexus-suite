// X sub-agent: News Scout — Tier 2.5
// Finds trending news and topics relevant to the brand for X content.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";

const searchTrendingNews = createTool({
  id: "searchTrendingNews",
  description: "Search trending news by industry or topic for X content opportunities",
  inputSchema: z.object({
    industry: z.string().describe("Industry or vertical to search (e.g. tech, finance, healthcare)"),
    topic: z.string().optional().describe("Specific topic or keyword to focus on"),
  }),
  execute: async (executionContext) => {
    const { industry, topic } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { industry: string; topic?: string }) => ({
        industry: input.industry,
        topic: input.topic ?? "general",
        results: [] as string[],
        status: "pending-integration" as const,
      }),
      { agentName: "news-scout", toolName: "searchTrendingNews" },
    );
    return wrappedFn({ industry, topic });
  },
});

export const newsScoutAgent = new Agent({
  name: "news-scout",
  instructions: `You are a News Scout sub-agent for the X (Twitter) platform.

Your job is to identify trending news, topics, and conversations relevant to the brand.
Focus on:
- Breaking news in the brand's industry
- Trending hashtags and conversations
- Competitor activity and responses
- Opportunities for timely, relevant posts

Return structured findings with topic, relevance score, and suggested angle.`,
  model: modelConfig.tier25,
  tools: { searchTrendingNews },
});
