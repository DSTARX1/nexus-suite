import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";
import { prepareContext } from "../general/prepare-context";
import { buildSystemPrompt } from "../general/prompts";
import type { RawAgentContext } from "../general/types";
import { db } from "@/lib/db";

const AGENT_NAME = "analytics-reporter";

const INSTRUCTIONS = `You are the Analytics Reporter for Nexus Suite.

Single task: Generate performance reports with trend detection and insights.

Capabilities:
- Query analytics data across platforms
- Detect performance trends (growth, decline, anomalies)
- Compare content performance across time periods
- Generate actionable insights and recommendations

Output format:
Return JSON with:
- "summary": executive summary of performance
- "metrics": { impressions, engagement_rate, reach, clicks, conversions }
- "trends": array of { metric, direction, magnitude, period }
- "top_content": best performing content in period
- "recommendations": array of actionable next steps`;

function parsePeriodDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : 30;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

const queryAnalytics = createTool({
  id: "queryAnalytics",
  description: "Fetch engagement, reach, and follower data by platform and time period",
  inputSchema: z.object({
    platform: z.string().describe("Platform to query (youtube, tiktok, instagram, etc.)"),
    period: z.string().optional().describe("Time period: 7d, 30d, 90d"),
    metrics: z.array(z.string()).optional().describe("Specific metrics to fetch"),
  }),
  execute: async (executionContext) => {
    const { platform, period, metrics } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { platform: string; period?: string; metrics?: string[] }) => {
        const days = parsePeriodDays(input.period ?? "30d");
        const since = daysAgo(days);
        const platformUpper = input.platform.toUpperCase();

        // Query own post records for this platform
        const postGroups = await db.postRecord.groupBy({
          by: ["status"],
          where: {
            platform: platformUpper as never,
            createdAt: { gte: since },
          },
          _count: true,
        });

        let totalPosts = 0;
        let successPosts = 0;
        for (const g of postGroups) {
          totalPosts += g._count;
          if (g.status === "SUCCESS") successPosts = g._count;
        }

        // Query tracked competitor posts for this platform
        const trackedAgg = await db.trackedPost.aggregate({
          where: {
            creator: { platform: platformUpper as never },
            createdAt: { gte: since },
          },
          _sum: { views: true, likes: true, comments: true },
          _count: true,
          _avg: { views: true, likes: true },
        });

        // Snapshot trend — compare first half vs second half of period
        const midpoint = daysAgo(Math.floor(days / 2));
        const [firstHalf, secondHalf] = await Promise.all([
          db.postSnapshot.aggregate({
            where: {
              capturedAt: { gte: since, lt: midpoint },
              post: { creator: { platform: platformUpper as never } },
            },
            _avg: { views: true, likes: true },
            _count: true,
          }),
          db.postSnapshot.aggregate({
            where: {
              capturedAt: { gte: midpoint },
              post: { creator: { platform: platformUpper as never } },
            },
            _avg: { views: true, likes: true },
            _count: true,
          }),
        ]);

        const viewsTrend =
          firstHalf._avg.views && secondHalf._avg.views
            ? ((secondHalf._avg.views - firstHalf._avg.views) / firstHalf._avg.views) * 100
            : 0;

        const requestedMetrics = input.metrics ?? ["impressions", "engagement_rate", "reach"];

        return {
          platform: input.platform,
          period: input.period ?? "30d",
          metrics: requestedMetrics,
          data: {
            ownPosts: { total: totalPosts, successful: successPosts },
            trackedPosts: {
              count: trackedAgg._count,
              totalViews: trackedAgg._sum.views ?? 0,
              totalLikes: trackedAgg._sum.likes ?? 0,
              totalComments: trackedAgg._sum.comments ?? 0,
              avgViews: Math.round(trackedAgg._avg.views ?? 0),
              avgLikes: Math.round(trackedAgg._avg.likes ?? 0),
            },
            trends: {
              viewsChange: Math.round(viewsTrend * 10) / 10,
              direction: viewsTrend > 5 ? "up" : viewsTrend < -5 ? "down" : "stable",
            },
          },
        };
      },
      { agentName: AGENT_NAME, toolName: "queryAnalytics" },
    );
    return wrappedFn({ platform, period, metrics });
  },
});

const analyticsReporterAgent = new Agent({
  name: AGENT_NAME,
  instructions: INSTRUCTIONS,
  model: modelConfig.tier25,
  tools: { queryAnalytics },
});

export function createAgent() {
  return analyticsReporterAgent;
}

export async function generate(
  prompt: string,
  rawContext: RawAgentContext,
  opts?: { model?: string; maxTokens?: number },
) {
  const ctx = prepareContext(AGENT_NAME, rawContext);
  const systemPrompt = buildSystemPrompt(
    INSTRUCTIONS,
    ctx.brandVoice as string | undefined,
  );

  const result = await analyticsReporterAgent.generate(prompt, {
    instructions: systemPrompt,
    maxTokens: opts?.maxTokens,
  });

  return {
    text: result.text,
    usage: result.usage
      ? {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          model: opts?.model ?? "default",
        }
      : undefined,
    toolCalls: result.toolCalls?.map((tc) => ({
      name: tc.toolName,
      args: tc.args as Record<string, unknown>,
      result: undefined,
    })),
  };
}
