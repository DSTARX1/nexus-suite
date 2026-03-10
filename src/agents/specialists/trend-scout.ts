// Trend Scout — Tier 3 shared specialist
// Monitors trending topics across platforms for content opportunities.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";
import { db } from "@/lib/db";

const getRssArticles = createTool({
  id: "getRssArticles",
  description:
    "Fetch recent RSS articles from monitored news feeds. Filter by organization and optional keyword search.",
  inputSchema: z.object({
    organizationId: z.string().describe("Organization ID to scope articles"),
    keyword: z.string().optional().describe("Optional keyword to filter article titles/summaries"),
    limit: z.number().min(1).max(50).default(20).describe("Max articles to return"),
    hoursBack: z.number().min(1).max(168).default(24).describe("How many hours back to look"),
  }),
  execute: async (executionContext) => {
    const { organizationId, keyword, limit, hoursBack } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: {
        organizationId: string;
        keyword?: string;
        limit: number;
        hoursBack: number;
      }) => {
        const since = new Date(Date.now() - input.hoursBack * 60 * 60 * 1000);

        const where: Record<string, unknown> = {
          organizationId: input.organizationId,
          fetchedAt: { gte: since },
        };

        if (input.keyword) {
          where.OR = [
            { title: { contains: input.keyword, mode: "insensitive" } },
            { summary: { contains: input.keyword, mode: "insensitive" } },
          ];
        }

        const articles = await db.rssArticle.findMany({
          where,
          take: input.limit,
          orderBy: { publishedAt: "desc" },
          select: {
            title: true,
            url: true,
            summary: true,
            author: true,
            publishedAt: true,
            feed: { select: { name: true } },
          },
        });

        return {
          articles: articles.map((a) => ({
            title: a.title,
            url: a.url,
            summary: a.summary,
            author: a.author,
            publishedAt: a.publishedAt?.toISOString() ?? null,
            feedName: a.feed.name,
          })),
          count: articles.length,
          status: "ok" as const,
        };
      },
      { agentName: "trend-scout", toolName: "getRssArticles" },
    );
    return wrappedFn({ organizationId, keyword, limit, hoursBack });
  },
});

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

const searchTwitter = createTool({
  id: "searchTwitter",
  description: "Search Twitter/X for trending topics and viral posts",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    timeframe: z.string().optional().describe("Time range: 1h, 24h, 7d"),
  }),
  execute: async (executionContext) => {
    const { query, timeframe } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { query: string; timeframe?: string }) => ({
        query: input.query,
        timeframe: input.timeframe ?? "24h",
        tweets: [] as string[],
        status: "pending-integration" as const,
      }),
      { agentName: "trend-scout", toolName: "searchTwitter" },
    );
    return wrappedFn({ query, timeframe });
  },
});

const searchHackerNews = createTool({
  id: "searchHackerNews",
  description: "Search Hacker News for trending tech topics",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    sortBy: z.enum(["relevance", "date", "points"]).optional().describe("Sort order"),
  }),
  execute: async (executionContext) => {
    const { query, sortBy } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { query: string; sortBy?: string }) => ({
        query: input.query,
        sortBy: input.sortBy ?? "relevance",
        stories: [] as string[],
        status: "pending-integration" as const,
      }),
      { agentName: "trend-scout", toolName: "searchHackerNews" },
    );
    return wrappedFn({ query, sortBy });
  },
});

const searchReddit = createTool({
  id: "searchReddit",
  description: "Search Reddit for trending discussions and content ideas",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    subreddit: z.string().optional().describe("Specific subreddit to search"),
  }),
  execute: async (executionContext) => {
    const { query, subreddit } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { query: string; subreddit?: string }) => ({
        query: input.query,
        subreddit: input.subreddit ?? "all",
        posts: [] as string[],
        status: "pending-integration" as const,
      }),
      { agentName: "trend-scout", toolName: "searchReddit" },
    );
    return wrappedFn({ query, subreddit });
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
- Recent RSS news articles from monitored feeds

Return concise, actionable trend insights. Focus on timeliness and relevance to the creator's niche.`,
  model: modelConfig.tier25,
  tools: { getRssArticles, searchTrends, searchTwitter, searchHackerNews, searchReddit },
});
