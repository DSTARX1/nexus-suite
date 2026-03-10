// Instagram Platform Main Agent — Tier 2
// Extended with Graph API comment fetch/reply tools and posting pipeline.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { executeAgentDelegate, getWorkflowContext } from "@/server/workflows/agent-delegate";
import { modelConfig } from "@/agents/platforms/model-config";
import { scheduleInstagramPost, getInstagramPostStatus } from "./tools/post";

const GRAPH_API = "https://graph.facebook.com/v21.0";

const delegateToSubAgent = createTool({
  id: "delegateToSubAgent",
  description:
    "Delegate a task to an Instagram sub-agent by name (carousel-sequencer, story-formatter)",
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
      { agentName: "instagram-main", toolName: "delegateToSubAgent" },
    );
    return wrappedFn({ subAgentName, prompt });
  },
});

const fetchIGComments = createTool({
  id: "fetchIGComments",
  description: "Fetch comments on an Instagram media post via the Graph API",
  inputSchema: z.object({
    accessToken: z.string().describe("Instagram Graph API access token"),
    mediaId: z.string().describe("Instagram media ID"),
    limit: z.number().optional().describe("Max comments to return (default: 50)"),
  }),
  execute: async (executionContext) => {
    const { accessToken, mediaId, limit } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { accessToken: string; mediaId: string; limit?: number }) => {
        const maxComments = input.limit ?? 50;
        const url = `${GRAPH_API}/${input.mediaId}/comments?fields=id,text,timestamp,username,like_count,replies{id,text,timestamp,username}&limit=${maxComments}&access_token=${input.accessToken}`;

        const res = await fetch(url);
        if (!res.ok) {
          const body = await res.text();
          return {
            comments: [],
            count: 0,
            error: `IG API error (${res.status}): ${body}`,
          };
        }

        const data = (await res.json()) as {
          data?: Array<{
            id: string;
            text: string;
            timestamp: string;
            username: string;
            like_count?: number;
            replies?: { data: Array<{ id: string; text: string; timestamp: string; username: string }> };
          }>;
        };

        return {
          comments: data.data ?? [],
          count: data.data?.length ?? 0,
          mediaId: input.mediaId,
        };
      },
      { agentName: "instagram-main", toolName: "fetchIGComments" },
    );
    return wrappedFn({ accessToken, mediaId, limit });
  },
});

const replyToIGComment = createTool({
  id: "replyToIGComment",
  description: "Reply to a specific Instagram comment via the Graph API",
  inputSchema: z.object({
    accessToken: z.string().describe("Instagram Graph API access token"),
    commentId: z.string().describe("Instagram comment ID to reply to"),
    message: z.string().describe("Reply text"),
  }),
  execute: async (executionContext) => {
    const { accessToken, commentId, message } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { accessToken: string; commentId: string; message: string }) => {
        const url = `${GRAPH_API}/${input.commentId}/replies`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: input.message,
            access_token: input.accessToken,
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          return {
            posted: false,
            error: `IG reply failed (${res.status}): ${body}`,
          };
        }

        const data = (await res.json()) as { id?: string };
        return {
          posted: true,
          replyId: data.id,
          commentId: input.commentId,
        };
      },
      { agentName: "instagram-main", toolName: "replyToIGComment" },
    );
    return wrappedFn({ accessToken, commentId, message });
  },
});

export const instagramMainAgent = new Agent({
  name: "instagram-main",
  instructions: `You are the Instagram Platform Main Agent. Your role is to handle all Instagram-related content tasks.

You can delegate to these sub-agents:
- carousel-sequencer: Plans slide order and content for carousel posts
- story-formatter: Formats content for Instagram Stories (stickers, polls, CTAs)

Use fetchIGComments to retrieve comments on posts and replyToIGComment to respond.
Use scheduleInstagramPost to queue content for posting through the rate-limited distribution pipeline.
Use getInstagramPostStatus to check on a scheduled post's progress.

For specialist tasks (captions, hashtags, SEO), delegate to shared Tier 3 specialists via the orchestrator.

Prioritize visual quality, engagement rate, and saves/shares. Optimize for the Explore page algorithm.`,
  model: modelConfig.tier2,
  tools: { delegateToSubAgent, fetchIGComments, replyToIGComment, scheduleInstagramPost, getInstagramPostStatus },
});
