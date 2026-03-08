// TikTok Platform Main Agent — Tier 2

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";

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
      async (input: { subAgentName: string; prompt: string }) => ({
        delegatedTo: input.subAgentName,
        prompt: input.prompt,
        status: "pending-wiring" as const,
      }),
      { agentName: "tiktok-main", toolName: "delegateToSubAgent" },
    );
    return wrappedFn({ subAgentName, prompt });
  },
});

export const tiktokMainAgent = new Agent({
  name: "tiktok-main",
  instructions: `You are the TikTok Platform Main Agent. Your role is to handle all TikTok-related content tasks.

You can delegate to these sub-agents:
- duet-stitch-logic: Plans duet and stitch strategies for collaborative content
- sound-selector: Selects trending sounds and music for maximum reach

For specialist tasks (hooks, captions, hashtags, trends), delegate to shared Tier 3 specialists via the orchestrator.

Prioritize algorithmic reach, trending sounds, and native TikTok formats. Content must feel authentic, not polished.`,
  model: modelConfig.tier2,
  tools: { delegateToSubAgent },
});
