import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";
import { prepareContext } from "../general/prepare-context";
import { buildSystemPrompt } from "../general/prompts";
import type { RawAgentContext } from "../general/types";
import { db } from "@/lib/db.js";

const AGENT_NAME = "viral-teardown-agent";

const SCRAPLING_URL =
  process.env.SCRAPLING_URL ?? "http://scrapling-sidecar:8000";

const INSTRUCTIONS = `You are the Viral Tear-down Agent for Nexus Suite.

Single task: Analyze viral content and generate a "Viral Recipe" report.

Capabilities:
- Fetch viral post data from scraper-pool or scrapling sidecar
- Analyze pacing, hook structure, retention curves
- Identify replicable patterns: format, topic selection, posting time
- Score virality factors: shareability, emotional trigger, novelty

Output format:
Return JSON with:
- "viral_recipe": structured breakdown of why the content went viral
- "hook_analysis": { type, text, retention_impact }
- "pacing": { avg_scene_length, cuts_per_minute, energy_curve }
- "replicable_elements": array of patterns that can be reused
- "virality_score": 0-100 virality potential rating
- "content_template": a template based on the viral content structure`;

interface FetchedContent {
  url: string | null;
  platform: string;
  title: string | null;
  description: string | null;
  views: number;
  likes: number;
  comments: number;
  creator: string | null;
  thumbnail: string | null;
}

/** Attempt to load post data from the DB (TrackedPost) first. */
async function loadFromDb(url: string): Promise<FetchedContent | null> {
  const post = await db.trackedPost.findFirst({
    where: { url },
    include: { creator: { select: { platform: true, username: true } } },
  });
  if (!post) return null;
  return {
    url: post.url,
    platform: post.creator.platform,
    title: post.title,
    description: post.title,
    views: post.views,
    likes: post.likes,
    comments: post.comments,
    creator: post.creator.username,
    thumbnail: post.thumbnailUrl,
  };
}

/** Scrape a profile page via scrapling sidecar and pick the matching post. */
async function scrapeViaScrapling(
  url: string,
  platform: string,
): Promise<FetchedContent | null> {
  try {
    const resp = await fetch(`${SCRAPLING_URL}/scrape/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, platform }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      posts: Array<{
        title?: string | null;
        url?: string | null;
        thumbnail?: string | null;
        views?: string | null;
        likes?: string | null;
        comments?: string | null;
      }>;
    };
    const first = data.posts[0];
    if (!first) return null;
    return {
      url: first.url ?? url,
      platform,
      title: first.title ?? null,
      description: first.title ?? null,
      views: parseCount(first.views),
      likes: parseCount(first.likes),
      comments: parseCount(first.comments),
      creator: null,
      thumbnail: first.thumbnail ?? null,
    };
  } catch {
    return null;
  }
}

function parseCount(value: string | null | undefined): number {
  if (!value) return 0;
  const cleaned = value.replace(/[^0-9.kmb]/gi, "").toLowerCase();
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  if (cleaned.endsWith("b")) return Math.round(num * 1_000_000_000);
  if (cleaned.endsWith("m")) return Math.round(num * 1_000_000);
  if (cleaned.endsWith("k")) return Math.round(num * 1_000);
  return Math.round(num);
}

function detectPlatform(url: string): string {
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/twitter\.com|x\.com/i.test(url)) return "x";
  return "unknown";
}

const fetchViralContent = createTool({
  id: "fetchViralContent",
  description:
    "Fetch viral post data for analysis. Loads from DB if available, otherwise scrapes via scraper-pool or scrapling sidecar.",
  inputSchema: z.object({
    url: z.string().optional().describe("URL of viral content to analyze"),
    platform: z.string().optional().describe("Platform to search for viral content"),
    niche: z.string().optional().describe("Content niche to filter by"),
  }),
  execute: async (executionContext) => {
    const { url, platform, niche } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { url?: string; platform?: string; niche?: string }) => {
        const resolvedPlatform =
          input.platform ?? (input.url ? detectPlatform(input.url) : "all");

        // If a direct URL is provided, fetch its data
        if (input.url) {
          // 1. Try DB
          const dbContent = await loadFromDb(input.url);
          if (dbContent) {
            return {
              url: input.url,
              platform: resolvedPlatform,
              niche: input.niche ?? "general",
              content: dbContent,
              status: "ok" as const,
            };
          }

          // 2. Scrape via scrapling sidecar
          const scraped = await scrapeViaScrapling(input.url, resolvedPlatform);
          if (scraped) {
            return {
              url: input.url,
              platform: resolvedPlatform,
              niche: input.niche ?? "general",
              content: scraped,
              status: "ok" as const,
            };
          }
        }

        // 3. No URL — find outlier posts from DB
        const outliers = await db.trackedPost.findMany({
          where: { isOutlier: true },
          orderBy: { outlierScore: "desc" },
          take: 5,
          include: { creator: { select: { platform: true, username: true } } },
        });

        if (outliers.length > 0) {
          const mapped: FetchedContent[] = outliers.map((p) => ({
            url: p.url,
            platform: p.creator.platform,
            title: p.title,
            description: p.title,
            views: p.views,
            likes: p.likes,
            comments: p.comments,
            creator: p.creator.username,
            thumbnail: p.thumbnailUrl,
          }));

          return {
            url: input.url ?? null,
            platform: resolvedPlatform,
            niche: input.niche ?? "general",
            content: mapped[0],
            additionalOutliers: mapped.slice(1),
            status: "ok" as const,
          };
        }

        return {
          url: input.url ?? null,
          platform: resolvedPlatform,
          niche: input.niche ?? "general",
          content: null as FetchedContent | null,
          status: "no_content" as const,
        };
      },
      { agentName: AGENT_NAME, toolName: "fetchViralContent" },
    );
    return wrappedFn({ url, platform, niche });
  },
});

const viralTeardownAgent = new Agent({
  name: AGENT_NAME,
  instructions: INSTRUCTIONS,
  model: modelConfig.tier25,
  tools: { fetchViralContent },
});

export function createAgent() {
  return viralTeardownAgent;
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

  const result = await viralTeardownAgent.generate(prompt, {
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
