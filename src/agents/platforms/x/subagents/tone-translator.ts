// X sub-agent: Tone Translator — Tier 2.5
// Adapts content to X's conversational, concise tone.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";

const adaptTone = createTool({
  id: "adaptTone",
  description: "Adapt content to X-native tone with target style parameters",
  inputSchema: z.object({
    content: z.string().describe("Original content to adapt for X"),
    targetTone: z.string().optional().describe("Target tone (e.g. witty, informative, casual)"),
    format: z.enum(["single-tweet", "thread"]).optional().describe("Output format"),
  }),
  execute: async (executionContext) => {
    const { content, targetTone, format } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { content: string; targetTone?: string; format?: string }) => ({
        content: input.content,
        targetTone: input.targetTone ?? "conversational",
        format: input.format ?? "single-tweet",
        adapted: "",
        status: "pending-integration" as const,
      }),
      { agentName: "tone-translator", toolName: "adaptTone" },
    );
    return wrappedFn({ content, targetTone, format });
  },
});

export const toneTranslatorAgent = new Agent({
  name: "tone-translator",
  instructions: `You are a Tone Translator sub-agent for the X (Twitter) platform.

Your job is to adapt content from other formats into X's native tone:
- Conversational and punchy
- Under 280 characters for single tweets
- Thread-friendly for longer content (numbered, each tweet standalone)
- Use of line breaks for readability
- Strategic emoji/punctuation (not excessive)

Never sound corporate or stiff. Match the brand voice while being native to X.`,
  model: modelConfig.tier25,
  tools: { adaptTone },
});
