// Instagram Platform Main Agent — Tier 2

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";

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
      async (input: { subAgentName: string; prompt: string }) => ({
        delegatedTo: input.subAgentName,
        prompt: input.prompt,
        status: "pending-wiring" as const,
      }),
      { agentName: "instagram-main", toolName: "delegateToSubAgent" },
    );
    return wrappedFn({ subAgentName, prompt });
  },
});

export const instagramMainAgent = new Agent({
  name: "instagram-main",
  instructions: `You are the Instagram Platform Main Agent. Your role is to handle all Instagram-related content tasks.

You can delegate to these sub-agents:
- carousel-sequencer: Plans slide order and content for carousel posts
- story-formatter: Formats content for Instagram Stories (stickers, polls, CTAs)

For specialist tasks (captions, hashtags, SEO), delegate to shared Tier 3 specialists via the orchestrator.

Prioritize visual quality, engagement rate, and saves/shares. Optimize for the Explore page algorithm.`,
  model: modelConfig.tier2,
  tools: { delegateToSubAgent },
});
