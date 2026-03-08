// TikTok sub-agent: Duet/Stitch Logic — Tier 2.5
// Plans duet and stitch strategies for collaborative TikTok content.

import { Agent } from "@mastra/core/agent";
import { modelConfig } from "@/agents/platforms/model-config";

export const duetStitchLogicAgent = new Agent({
  name: "duet-stitch-logic",
  instructions: `You are a Duet/Stitch Logic sub-agent for the TikTok platform.

Your job is to plan duet and stitch strategies:
- Identify viral videos suitable for duet or stitch
- Plan reaction timing and content for duets
- Determine optimal stitch points (first 5 seconds of source)
- Suggest value-add commentary or reactions
- Ensure brand alignment while being authentic

Duets: side-by-side reactions, tutorials, comparisons
Stitches: use opening clip then add original content

Always prioritize adding genuine value over clout-chasing.`,
  model: modelConfig.tier25,
});
