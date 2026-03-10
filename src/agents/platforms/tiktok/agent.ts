// TikTok Platform Main Agent — Tier 2
// Extended with comment fetching via scraper-pool and posting pipeline.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { executeAgentDelegate, getWorkflowContext } from "@/server/workflows/agent-delegate";
import { modelConfig } from "@/agents/platforms/model-config";
import { scheduleTikTokPost, getTikTokPostStatus } from "./tools/post";

const SCRAPER_POOL_URL = process.env.SCRAPER_POOL_URL ?? "http://localhost:3100";

const delegateToSubAgent = createTool({
  id: "delegateToSubAgent",
  description:
    "Delegate a task to a TikTok sub-agent by name (duet-stitch-logic, sound-selector)",
  inputSchema: z.object({
    subAgentName: z.string().describe("Name of the sub-agent to delegate to"),
    prompt: z.string().describe("Task prompt for the sub-agent"),
  }),
  execute: async (executionContext) => {
    const { subAgentName, prompt } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { subAgentName: string; prompt: string }) => {
        const workflowContext = getWorkflowContext();
        const result = await executeAgentDelegate(input.subAgentName, input.prompt, workflowContext);
        return {
          delegatedTo: input.subAgentName,
          result,
          status: "delegated" as const,
        };
      },
      { agentName: "tiktok-main", toolName: "delegateToSubAgent" },
    );
    return wrappedFn({ subAgentName, prompt });
  },
});

const fetchTikTokComments = createTool({
  id: "fetchTikTokComments",
  description: "Fetch comments from a TikTok video via the scraper-pool service",
  inputSchema: z.object({
    videoUrl: z.string().describe("Full TikTok video URL to scrape comments from"),
    limit: z.number().optional().describe("Max comments to return (default: 30)"),
  }),
  execute: async (executionContext) => {
    const { videoUrl, limit } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { videoUrl: string; limit?: number }) => {
        const res = await fetch(`${SCRAPER_POOL_URL}/scrape/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoUrl: input.videoUrl,
            platform: "tiktok",
            limit: input.limit ?? 30,
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          return {
            comments: [],
            count: 0,
            error: `Scraper error (${res.status}): ${body}`,
          };
        }

        const data = (await res.json()) as {
          comments?: Array<{ username?: string; text?: string; likes?: string; timestamp?: string }>;
          count?: number;
        };

        return {
          comments: data.comments ?? [],
          count: data.count ?? 0,
          videoUrl: input.videoUrl,
        };
      },
      { agentName: "tiktok-main", toolName: "fetchTikTokComments" },
    );
    return wrappedFn({ videoUrl, limit });
  },
});

export const tiktokMainAgent = new Agent({
  name: "tiktok-main",
  instructions: `You are the TikTok Platform Main Agent. Your role is to handle all TikTok-related content tasks.

You can delegate to these sub-agents:
- duet-stitch-logic: Plans duet and stitch strategies for collaborative content
- sound-selector: Selects trending sounds and music for maximum reach

Use fetchTikTokComments to retrieve comments from TikTok videos for engagement analysis.
Use scheduleTikTokPost to queue video content for posting through the rate-limited distribution pipeline.
Use getTikTokPostStatus to check on a scheduled post's progress.

For specialist tasks (hooks, captions, hashtags, trends), delegate to shared Tier 3 specialists via the orchestrator.

Prioritize algorithmic reach, trending sounds, and native TikTok formats. Content must feel authentic, not polished.
Note: Unaudited TikTok apps post as SELF_ONLY. Audit required for PUBLIC_TO_EVERYONE.`,
  model: modelConfig.tier2,
  tools: { delegateToSubAgent, fetchTikTokComments, scheduleTikTokPost, getTikTokPostStatus },
});
