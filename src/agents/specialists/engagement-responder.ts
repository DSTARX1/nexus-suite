import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler, validateReply, incrementReplyRate } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";
import { prepareContext } from "../general/prepare-context";
import { buildSystemPrompt } from "../general/prompts";
import type { RawAgentContext } from "../general/types";
import { getUserMentions, postTweet, type XOAuthCredentials } from "@/lib/x-api";

const AGENT_NAME = "engagement-responder";

const SCRAPER_POOL_URL = process.env.SCRAPER_POOL_URL ?? "http://localhost:3100";
const GRAPH_API = "https://graph.facebook.com/v21.0";

const INSTRUCTIONS = `You are the Engagement Responder for Nexus Suite.

Single task: Reply to comments and mentions with on-brand responses.

Capabilities:
- Analyze comment sentiment (positive, negative, neutral, spam)
- Generate contextual replies that maintain brand voice
- Apply reply templates for common scenarios (thanks, FAQ, complaints)
- Prioritize high-engagement comments for reply
- Fetch mentions from X, comments from Instagram and TikTok
- Validate replies through safety checks before posting

Output format:
Return JSON with:
- "reply": the response text
- "sentiment": detected sentiment of original comment
- "priority": reply priority (high, medium, low)
- "template_used": which reply template was applied
- "escalate": boolean if human review needed
- "safety": validation result from safety checks`;

// ── X Mentions Tool ─────────────────────────────────────────

const getRecentComments = createTool({
  id: "getRecentComments",
  description: "Fetch comments and mentions needing response from X (via API), Instagram (via Graph API), or TikTok (via scraper-pool)",
  inputSchema: z.object({
    platform: z.enum(["x", "instagram", "tiktok"]).describe("Platform to fetch comments from"),
    limit: z.number().optional().describe("Max comments to return"),
    unrespondedOnly: z.boolean().optional().describe("Only fetch unresponded comments"),
    // X-specific
    xBearerToken: z.string().optional().describe("X API Bearer Token for reading mentions"),
    xUserId: z.string().optional().describe("X user ID to fetch mentions for"),
    // Instagram-specific
    igAccessToken: z.string().optional().describe("Instagram Graph API access token"),
    igMediaId: z.string().optional().describe("Instagram media ID to fetch comments for"),
    // TikTok-specific
    tiktokVideoUrl: z.string().optional().describe("TikTok video URL to fetch comments for"),
  }),
  execute: async (executionContext) => {
    const ctx = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: typeof ctx) => {
        const limit = input.limit ?? 50;

        switch (input.platform) {
          case "x": {
            if (!input.xBearerToken || !input.xUserId) {
              return { platform: "x", comments: [], error: "Missing xBearerToken or xUserId" };
            }
            const mentions = await getUserMentions(input.xBearerToken, input.xUserId, limit);
            return {
              platform: "x",
              comments: (mentions.data ?? []).map((tweet) => ({
                id: tweet.id,
                text: tweet.text,
                authorId: tweet.author_id,
                createdAt: tweet.created_at,
                metrics: tweet.public_metrics,
                author: mentions.includes?.users?.find((u) => u.id === tweet.author_id),
              })),
              count: mentions.meta?.result_count ?? 0,
            };
          }
          case "instagram": {
            if (!input.igAccessToken || !input.igMediaId) {
              return { platform: "instagram", comments: [], error: "Missing igAccessToken or igMediaId" };
            }
            const url = `${GRAPH_API}/${input.igMediaId}/comments?fields=id,text,timestamp,username,like_count,replies{id,text,timestamp,username}&limit=${limit}&access_token=${input.igAccessToken}`;
            const res = await fetch(url);
            if (!res.ok) {
              const body = await res.text();
              return { platform: "instagram", comments: [], error: `IG API error ${res.status}: ${body}` };
            }
            const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
            return {
              platform: "instagram",
              comments: data.data ?? [],
              count: data.data?.length ?? 0,
            };
          }
          case "tiktok": {
            if (!input.tiktokVideoUrl) {
              return { platform: "tiktok", comments: [], error: "Missing tiktokVideoUrl" };
            }
            // Route through scraper-pool for TikTok comment scraping
            const res = await fetch(`${SCRAPER_POOL_URL}/scrape/comments`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                videoUrl: input.tiktokVideoUrl,
                platform: "tiktok",
                limit,
              }),
            });
            if (!res.ok) {
              const body = await res.text();
              return { platform: "tiktok", comments: [], error: `Scraper error ${res.status}: ${body}` };
            }
            const data = (await res.json()) as { comments?: Array<Record<string, unknown>>; count?: number };
            return {
              platform: "tiktok",
              comments: data.comments ?? [],
              count: data.count ?? 0,
            };
          }
        }
      },
      { agentName: AGENT_NAME, toolName: "getRecentComments" },
    );
    return wrappedFn(ctx);
  },
});

// ── Post Reply Tool ─────────────────────────────────────────

const postReply = createTool({
  id: "postReply",
  description: "Post a reply to a comment/mention after safety validation. Supports X (via API), Instagram (via Graph API).",
  inputSchema: z.object({
    platform: z.enum(["x", "instagram"]).describe("Platform to reply on"),
    replyText: z.string().describe("The reply text to post"),
    organizationId: z.string().describe("Organization ID for rate limiting"),
    brandVoice: z.string().optional().describe("Brand voice for safety validation"),
    // X-specific
    xOAuthCredentials: z.object({
      apiKey: z.string(),
      apiSecret: z.string(),
      accessToken: z.string(),
      accessTokenSecret: z.string(),
    }).optional().describe("X OAuth 1.0a credentials for posting"),
    inReplyToTweetId: z.string().optional().describe("Tweet ID to reply to"),
    // Instagram-specific
    igAccessToken: z.string().optional().describe("Instagram Graph API access token"),
    igCommentId: z.string().optional().describe("Instagram comment ID to reply to"),
  }),
  execute: async (executionContext) => {
    const ctx = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: typeof ctx) => {
        // Safety validation first
        const validation = await validateReply(
          input.replyText,
          input.platform,
          input.organizationId,
          input.brandVoice,
        );

        if (!validation.approved) {
          return {
            posted: false,
            safety: validation,
            error: `Reply blocked: ${validation.reasons.join("; ")}`,
          };
        }

        switch (input.platform) {
          case "x": {
            if (!input.xOAuthCredentials || !input.inReplyToTweetId) {
              return { posted: false, error: "Missing X OAuth credentials or tweet ID" };
            }
            const creds: XOAuthCredentials = input.xOAuthCredentials;
            const result = await postTweet(input.replyText, creds, input.inReplyToTweetId);
            await incrementReplyRate("x", input.organizationId);
            return {
              posted: true,
              externalId: result.data.id,
              platform: "x",
              safety: validation,
            };
          }
          case "instagram": {
            if (!input.igAccessToken || !input.igCommentId) {
              return { posted: false, error: "Missing IG access token or comment ID" };
            }
            const url = `${GRAPH_API}/${input.igCommentId}/replies`;
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                message: input.replyText,
                access_token: input.igAccessToken,
              }),
            });
            if (!res.ok) {
              const body = await res.text();
              return { posted: false, error: `IG reply failed (${res.status}): ${body}` };
            }
            const data = (await res.json()) as { id?: string };
            await incrementReplyRate("instagram", input.organizationId);
            return {
              posted: true,
              externalId: data.id,
              platform: "instagram",
              safety: validation,
            };
          }
        }
      },
      { agentName: AGENT_NAME, toolName: "postReply" },
    );
    return wrappedFn(ctx);
  },
});

// Update tool scope to include both tools
const engagementResponderAgent = new Agent({
  name: AGENT_NAME,
  instructions: INSTRUCTIONS,
  model: modelConfig.tier25,
  tools: { getRecentComments, postReply },
});

export function createAgent() {
  return engagementResponderAgent;
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

  const result = await engagementResponderAgent.generate(prompt, {
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
