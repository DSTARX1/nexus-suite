// Thread Writer — Tier 3 shared specialist
// Creates multi-post threads with narrative arc and engagement hooks.
// Wired to X API v2 for thread posting and content splitting.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";
import { prepareContext } from "../general/prepare-context";
import { buildSystemPrompt } from "../general/prompts";
import type { RawAgentContext } from "../general/types";
import {
  splitIntoThreadChunks,
  postThread,
  type XOAuthCredentials,
} from "@/lib/x-api";

const AGENT_NAME = "thread-writer";

const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  x: 280,
  linkedin: 3000,
  threads: 500,
};

const HOOK_TEMPLATES: Record<string, string[]> = {
  listicle: [
    "Here's what most people get wrong 👇",
    "Let me break it down for you...",
    "The data doesn't lie:",
    "But wait, there's more...",
    "And the #1 takeaway?",
  ],
  story: [
    "It all started when...",
    "Then something unexpected happened.",
    "The turning point came when...",
    "And here's the lesson:",
    "The result? 👇",
  ],
  educational: [
    "Let me explain 🧵",
    "First, the basics:",
    "Now here's where it gets interesting...",
    "The key insight:",
    "TL;DR for those just joining:",
  ],
};

const CTA_TEMPLATES = [
  "Follow for more insights like this 🔔",
  "RT/Repost if this helped you 🔁",
  "Drop a 🔥 if you found this useful",
  "Save this thread — you'll need it later 📌",
  "What would you add? Reply below 👇",
];

const INSTRUCTIONS = `You are the Thread Writer for Nexus Suite.

Single task: Create multi-post threads with narrative arc and engagement hooks.

Capabilities:
- Break long-form content into threaded posts (X threads, LinkedIn carousels)
- Apply narrative templates: listicle, story arc, educational breakdown
- Chunk content to platform limits while maintaining flow
- Add engagement hooks between posts (cliffhangers, questions)
- Post completed threads directly to X via API

Output format:
Return JSON with:
- "posts": array of { index, content, char_count }
- "total_posts": number of posts in thread
- "narrative_type": template used
- "engagement_hooks": hooks placed between posts
- "estimated_read_time": total read time in seconds
- "posted_ids": array of tweet IDs if thread was posted`;

const getThreadStructure = createTool({
  id: "getThreadStructure",
  description: "Get thread structure config: char limits, hook placement patterns, CTA templates, and split content into chunks",
  inputSchema: z.object({
    platform: z.string().describe("Target platform (x, linkedin, threads)"),
    narrativeType: z.enum(["listicle", "story", "educational"]).optional().describe("Narrative template"),
    postCount: z.number().optional().describe("Target number of posts"),
    content: z.string().optional().describe("Content to split into thread chunks"),
    numbered: z.boolean().optional().describe("Add numbering to posts (e.g. 1/N)"),
    // Thread posting params (optional)
    post: z.boolean().optional().describe("Whether to post the thread to X"),
    oauthCredentials: z.object({
      apiKey: z.string(),
      apiSecret: z.string(),
      accessToken: z.string(),
      accessTokenSecret: z.string(),
    }).optional().describe("X OAuth 1.0a credentials for posting thread"),
  }),
  execute: async (executionContext) => {
    const ctx = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: typeof ctx) => {
        const platform = input.platform.toLowerCase();
        const charLimit = PLATFORM_CHAR_LIMITS[platform] ?? 280;
        const narrativeType = input.narrativeType ?? "listicle";
        const hooks = HOOK_TEMPLATES[narrativeType] ?? HOOK_TEMPLATES.listicle!;

        // Split content into chunks if provided
        let posts: Array<{ index: number; content: string; charCount: number }> = [];
        if (input.content) {
          const chunks = splitIntoThreadChunks(input.content, {
            numbered: input.numbered,
            maxChars: charLimit,
          });
          posts = chunks.map((chunk, i) => ({
            index: i + 1,
            content: chunk,
            charCount: chunk.length,
          }));
        }

        // Post thread if requested and we have content + credentials
        let postedIds: string[] = [];
        if (input.post && input.oauthCredentials && posts.length > 0 && platform === "x") {
          const creds: XOAuthCredentials = input.oauthCredentials;
          postedIds = await postThread(
            posts.map((p) => p.content),
            creds,
          );
        }

        // Estimated read time: ~200 words per minute
        const totalChars = posts.reduce((sum, p) => sum + p.charCount, 0);
        const wordCount = Math.ceil(totalChars / 5);
        const estimatedReadTimeSec = Math.ceil((wordCount / 200) * 60);

        return {
          platform,
          narrativeType,
          charLimit,
          maxPostCount: input.postCount ?? 10,
          hookPlacements: hooks,
          ctaPatterns: CTA_TEMPLATES,
          posts,
          totalPosts: posts.length,
          estimatedReadTime: estimatedReadTimeSec,
          postedIds,
        };
      },
      { agentName: AGENT_NAME, toolName: "getThreadStructure" },
    );
    return wrappedFn(ctx);
  },
});

const threadWriterAgent = new Agent({
  name: AGENT_NAME,
  instructions: INSTRUCTIONS,
  model: modelConfig.tier25,
  tools: { getThreadStructure },
});

export function createAgent() {
  return threadWriterAgent;
}

export async function generate(
  prompt: string,
  rawContext: RawAgentContext,
  opts?: { model?: string; maxTokens?: number },
) {
  const ctx = prepareContext(AGENT_NAME, rawContext);
  const systemPrompt = buildSystemPrompt(
    INSTRUCTIONS,
    ctx.brandVoice as string | undefined,
  );

  const result = await threadWriterAgent.generate(prompt, {
    instructions: systemPrompt,
    maxTokens: opts?.maxTokens,
  });

  return {
    text: result.text,
    usage: result.usage
      ? {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          model: opts?.model ?? "default",
        }
      : undefined,
    toolCalls: result.toolCalls?.map((tc) => ({
      name: tc.toolName,
      args: tc.args as Record<string, unknown>,
      result: undefined,
    })),
  };
}
