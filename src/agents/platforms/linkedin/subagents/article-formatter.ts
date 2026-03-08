// LinkedIn sub-agent: Article Formatter — Tier 2.5
// Formats long-form articles for LinkedIn's publishing platform.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";

const formatLinkedInArticle = createTool({
  id: "formatLinkedInArticle",
  description: "Takes raw content and returns a structured LinkedIn article with headline, sections, and tags",
  inputSchema: z.object({
    rawContent: z.string().describe("Raw content to format into a LinkedIn article"),
    targetAudience: z.string().optional().describe("Target professional audience (e.g. CTOs, marketers)"),
    tone: z.string().optional().describe("Article tone (e.g. thought-leadership, educational, case-study)"),
  }),
  execute: async (executionContext) => {
    const { rawContent, targetAudience, tone } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { rawContent: string; targetAudience?: string; tone?: string }) => ({
        rawContent: input.rawContent,
        targetAudience: input.targetAudience ?? "general professionals",
        tone: input.tone ?? "thought-leadership",
        headline: "",
        sections: [] as string[],
        tags: [] as string[],
        status: "pending-integration" as const,
      }),
      { agentName: "article-formatter", toolName: "formatLinkedInArticle" },
    );
    return wrappedFn({ rawContent, targetAudience, tone });
  },
});

export const articleFormatterAgent = new Agent({
  name: "article-formatter",
  instructions: `You are an Article Formatter sub-agent for the LinkedIn platform.

Your job is to format long-form content for LinkedIn Articles:
- Compelling headline (60-80 chars for full display)
- Cover image recommendation
- Introduction that hooks professionals (problem/insight)
- Subheadings every 2-3 paragraphs for scannability
- Pull quotes or key statistics highlighted
- Conclusion with actionable takeaways
- Author bio/CTA at the end

Articles should be 800-2000 words. Use data and case studies.
Format for both mobile and desktop reading.
Include relevant tags (up to 3) for discoverability.`,
  model: modelConfig.tier25,
  tools: { formatLinkedInArticle },
});
