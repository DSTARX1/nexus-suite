// Trend Scout — Tier 3 shared specialist
// Monitors trending topics across platforms for content opportunities.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general/index.js";
import { modelConfig } from "@/agents/platforms/model-config.js";
import { db } from "@/lib/db.js";
import {
  searchRecentTweets,
  getUserByUsername,
  getRateUsage,
  type XTweet,
  type XUser,
} from "@/lib/x-api.js";

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
  description:
    "Search Twitter/X for recent tweets matching a query. Returns tweet text, author info, and engagement metrics. Uses X API v2 with Bearer Token.",
  inputSchema: z.object({
    query: z.string().describe("Search query (supports X search operators like from:, #hashtag)"),
    maxResults: z
      .number()
      .min(10)
      .max(100)
      .default(10)
      .describe("Number of tweets to return (10-100)"),
  }),
  execute: async (executionContext) => {
    const { query, maxResults } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { query: string; maxResults: number }) => {
        const bearerToken = process.env.X_BEARER_TOKEN;
        if (!bearerToken) {
          return {
            query: input.query,
            tweets: [],
            rateUsage: null,
            status: "error" as const,
            error: "X_BEARER_TOKEN not configured",
          };
        }

        const result = await searchRecentTweets(bearerToken, input.query, input.maxResults);
        const userMap = new Map<string, XUser>();
        if (result.includes?.users) {
          for (const u of result.includes.users) {
            userMap.set(u.id, u);
          }
        }

        const tweets = (result.data ?? []).map((tweet: XTweet) => {
          const author = tweet.author_id ? userMap.get(tweet.author_id) : undefined;
          return {
            id: tweet.id,
            text: tweet.text,
            createdAt: tweet.created_at ?? null,
            authorUsername: author?.username ?? null,
            authorName: author?.name ?? null,
            metrics: tweet.public_metrics
              ? {
                  retweets: tweet.public_metrics.retweet_count,
                  replies: tweet.public_metrics.reply_count,
                  likes: tweet.public_metrics.like_count,
                  quotes: tweet.public_metrics.quote_count,
                }
              : null,
          };
        });

        const rateUsage = await getRateUsage();

        return {
          query: input.query,
          tweets,
          resultCount: result.meta?.result_count ?? 0,
          rateUsage,
          status: "ok" as const,
        };
      },
      { agentName: "trend-scout", toolName: "searchTwitter" },
    );
    return wrappedFn({ query, maxResults });
  },
});

const getXUserProfile = createTool({
  id: "getXUserProfile",
  description:
    "Look up a Twitter/X user profile by username. Returns bio, follower count, and other public info.",
  inputSchema: z.object({
    username: z.string().describe("X/Twitter username (without @)"),
  }),
  execute: async (executionContext) => {
    const { username } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { username: string }) => {
        const bearerToken = process.env.X_BEARER_TOKEN;
        if (!bearerToken) {
          return {
            username: input.username,
            user: null,
            status: "error" as const,
            error: "X_BEARER_TOKEN not configured",
          };
        }

        const result = await getUserByUsername(bearerToken, input.username);

        if (!result.data) {
          return {
            username: input.username,
            user: null,
            status: "not_found" as const,
          };
        }

        const u = result.data;
        return {
          username: u.username,
          user: {
            id: u.id,
            name: u.name,
            username: u.username,
            description: u.description ?? null,
            profileImageUrl: u.profile_image_url ?? null,
            followers: u.public_metrics?.followers_count ?? 0,
            following: u.public_metrics?.following_count ?? 0,
            tweetCount: u.public_metrics?.tweet_count ?? 0,
          },
          status: "ok" as const,
        };
      },
      { agentName: "trend-scout", toolName: "getXUserProfile" },
    );
    return wrappedFn({ username });
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
- Real-time Twitter/X posts and engagement data via searchTwitter
- Twitter/X user profiles and follower metrics via getXUserProfile

When using X/Twitter search, be mindful of the monthly rate limit (10k reads). Prefer focused, specific queries. Cache results are reused for 15 minutes.

Return concise, actionable trend insights. Focus on timeliness and relevance to the creator's niche.`,
  model: modelConfig.tier25,
  tools: { getRssArticles, searchTrends, searchTwitter, getXUserProfile, searchHackerNews, searchReddit },
});
