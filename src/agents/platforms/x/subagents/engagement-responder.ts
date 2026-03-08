// X sub-agent: Engagement Responder — Tier 2.5
// Crafts replies, quote tweets, and engagement responses for X.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";

const craftReply = createTool({
  id: "craftReply",
  description: "Craft a brand-voice reply to a tweet given the original tweet and context",
  inputSchema: z.object({
    originalTweet: z.string().describe("The tweet to reply to"),
    context: z.string().optional().describe("Additional context about the conversation or brand"),
    replyStyle: z.enum(["witty", "helpful", "insightful", "empathetic"]).optional().describe("Desired reply style"),
  }),
  execute: async (executionContext) => {
    const { originalTweet, context, replyStyle } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { originalTweet: string; context?: string; replyStyle?: string }) => ({
        originalTweet: input.originalTweet,
        context: input.context ?? "",
        replyStyle: input.replyStyle ?? "helpful",
        reply: "",
        status: "pending-integration" as const,
      }),
      { agentName: "x-engagement-responder", toolName: "craftReply" },
    );
    return wrappedFn({ originalTweet, context, replyStyle });
  },
});

export const engagementResponderAgent = new Agent({
  name: "x-engagement-responder",
  instructions: `You are an Engagement Responder sub-agent for the X (Twitter) platform.

Your job is to craft engaging responses to interactions:
- Replies to mentions and comments
- Quote tweets that add value
- Responses to trending conversations
- Community engagement in threads

Maintain brand voice while being authentic and conversational.
Avoid controversy. Prioritize helpful, witty, or insightful responses.`,
  model: modelConfig.tier25,
  tools: { craftReply },
});
