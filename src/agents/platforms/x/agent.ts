// X (Twitter) Platform Main Agent — Tier 2
// Receives tasks from Orchestrator, delegates to Tier 2.5 sub-agents or Tier 3 specialists.
// Wired with posting tools that route through the distribution-scheduler pipeline.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { executeAgentDelegate, getWorkflowContext } from "@/server/workflows/agent-delegate";
import { modelConfig } from "@/agents/platforms/model-config";
import { scheduleXPost, postXThread } from "./tools/post";

const delegateToSubAgent = createTool({
  id: "delegateToSubAgent",
  description:
    "Delegate a task to an X platform sub-agent by name (news-scout, tone-translator, x-engagement-responder)",
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
      { agentName: "x-main", toolName: "delegateToSubAgent" },
    );
    return wrappedFn({ subAgentName, prompt });
  },
});

export const xMainAgent = new Agent({
  name: "x-main",
  instructions: `You are the X (Twitter) Platform Main Agent. Your role is to handle all X/Twitter-related content tasks.

You can delegate to these sub-agents:
- news-scout: Finds trending news and topics relevant to the brand
- tone-translator: Adapts content to X's conversational, concise tone
- x-engagement-responder: Crafts replies, quote tweets, and engagement responses

Use scheduleXPost to queue video content for posting through the rate-limited distribution pipeline.
Use postXThread to publish long-form content as a thread of chained tweets.

For specialist tasks (SEO, hashtags, hooks), delegate to shared Tier 3 specialists via the orchestrator.

Always keep posts within X's character limits. Prioritize engagement and virality.`,
  model: modelConfig.tier2,
  tools: { delegateToSubAgent, scheduleXPost, postXThread },
});
