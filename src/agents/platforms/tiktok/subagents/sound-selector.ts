// TikTok sub-agent: Sound Selector — Tier 2.5
// Selects trending sounds and music for maximum TikTok reach.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";

const searchTrendingSounds = createTool({
  id: "searchTrendingSounds",
  description: "Search trending TikTok audio by niche or mood",
  inputSchema: z.object({
    niche: z.string().describe("Content niche to find sounds for (e.g. fitness, comedy, education)"),
    mood: z.string().optional().describe("Desired mood (e.g. upbeat, chill, dramatic)"),
  }),
  execute: async (executionContext) => {
    const { niche, mood } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { niche: string; mood?: string }) => ({
        niche: input.niche,
        mood: input.mood ?? "any",
        sounds: [] as string[],
        status: "pending-integration" as const,
      }),
      { agentName: "sound-selector", toolName: "searchTrendingSounds" },
    );
    return wrappedFn({ niche, mood });
  },
});

export const soundSelectorAgent = new Agent({
  name: "sound-selector",
  instructions: `You are a Sound Selector sub-agent for the TikTok platform.

Your job is to select optimal sounds and music:
- Identify trending sounds in the brand's niche
- Match sound mood to content type (educational, entertaining, emotional)
- Consider sound timing for key moments in the video
- Suggest original audio vs trending sound strategy
- Flag sounds with licensing concerns

Trending sounds boost algorithmic reach. Original audio builds brand identity.
Recommend the right balance based on content goals.`,
  model: modelConfig.tier25,
  tools: { searchTrendingSounds },
});
