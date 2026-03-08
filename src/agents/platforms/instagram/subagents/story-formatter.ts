// Instagram sub-agent: Story Formatter — Tier 2.5
// Formats content for Instagram Stories with interactive elements.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";

const formatStorySequence = createTool({
  id: "formatStorySequence",
  description: "Generate an Instagram Story slide plan with interactive element recommendations",
  inputSchema: z.object({
    content: z.string().describe("Raw content to format into story slides"),
    goal: z.string().optional().describe("Story goal (e.g. engagement, traffic, awareness)"),
  }),
  execute: async (executionContext) => {
    const { content, goal } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { content: string; goal?: string }) => ({
        content: input.content,
        goal: input.goal ?? "engagement",
        slides: [] as string[],
        interactiveElements: [] as string[],
        status: "pending-integration" as const,
      }),
      { agentName: "story-formatter", toolName: "formatStorySequence" },
    );
    return wrappedFn({ content, goal });
  },
});

export const storyFormatterAgent = new Agent({
  name: "story-formatter",
  instructions: `You are a Story Formatter sub-agent for the Instagram platform.

Your job is to format content for Instagram Stories:
- 9:16 vertical format, 1080x1920px
- 15-second segments for video, tappable for images
- Interactive elements: polls, quizzes, questions, sliders, countdowns
- Link stickers for CTAs
- Location and hashtag stickers for reach
- Text placement in safe zones (avoid top/bottom UI overlap)

Story sequence planning:
- Opening story: hook to stop tapping through
- Content stories: deliver value with interactive elements
- Closing story: CTA (swipe up, DM, link, poll)

Keep text minimal and readable. Use brand colors and fonts consistently.`,
  model: modelConfig.tier25,
  tools: { formatStorySequence },
});
