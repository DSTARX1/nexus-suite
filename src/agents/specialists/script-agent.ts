// Script Agent — Tier 3 shared specialist
// Writes full video scripts with pacing, structure, and brand voice.

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrapToolHandler } from "@/agents/general";
import { modelConfig } from "@/agents/platforms/model-config";
import { prepareContext } from "../general/prepare-context";
import { buildSystemPrompt } from "../general/prompts";
import type { RawAgentContext } from "../general/types";
import { db } from "@/lib/db.js";

const AGENT_NAME = "script-agent";

const INSTRUCTIONS = `You are the Script Agent for Nexus Suite.

Single task: Write full video scripts with pacing, structure, and brand voice.

Capabilities:
- Generate scripts for short-form (15s-3min) and long-form (3-60min) video
- Structure: hook → problem → solution → CTA
- Include visual directions, B-roll suggestions, and timing cues
- Apply brand voice and tone consistently
- Pass quality gate before delivery

Output format:
Return JSON with:
- "script": full script with timestamps and visual cues
- "duration_estimate": estimated video length in seconds
- "sections": array of { timestamp, content, visual_direction }
- "word_count": total word count
- "reading_speed": words per minute target`;

// ── Platform-specific script templates ────────────────────────

interface ScriptTemplate {
  structure: string[];
  pacingGuidelines: string[];
  charLimit: number;
  wordsPerMinute: number;
}

const TEMPLATES: Record<string, Record<string, ScriptTemplate>> = {
  tiktok: {
    short: {
      structure: [
        "0-3s: HOOK — Pattern interrupt, bold claim, or visual surprise",
        "3-10s: CONTEXT — Quick setup (who, what, why this matters)",
        "10-40s: VALUE — Main content, tips, or story beats",
        "40-55s: PAYOFF — Deliver the promise from the hook",
        "55-60s: CTA — Follow, like, comment, or save prompt",
      ],
      pacingGuidelines: [
        "1-2 second average shot length",
        "Use text overlays for key points",
        "Match cuts on the beat every 2-4 seconds",
        "Front-load value — 80% of viewers drop within 3s",
        "Use trending sounds when possible",
        "End with a loop or open question for replays",
      ],
      charLimit: 2200,
      wordsPerMinute: 180,
    },
    long: {
      structure: [
        "0-3s: HOOK — Grab attention immediately",
        "3-15s: SETUP — Establish topic and why viewers should stay",
        "15s-2m: BODY — Deep-dive content in 15-30s segments",
        "2m-2m45s: RECAP — Summarize key takeaways",
        "2m45s-3m: CTA — Strong call-to-action",
      ],
      pacingGuidelines: [
        "2-3 second average shot length",
        "Use chapter-style transitions",
        "Re-hook at 15s and 60s marks",
        "Include B-roll every 10-15 seconds",
      ],
      charLimit: 2200,
      wordsPerMinute: 160,
    },
  },
  instagram: {
    short: {
      structure: [
        "0-2s: HOOK — Arresting visual + text overlay",
        "2-8s: PROBLEM — Relatable situation or question",
        "8-25s: SOLUTION — Show the transformation or answer",
        "25-28s: RESULT — Before/after or proof",
        "28-30s: CTA — Save this, share, link in bio",
      ],
      pacingGuidelines: [
        "1.5-2s average cuts for Reels",
        "Vertical 9:16 aspect ratio",
        "Text overlays for silent viewing (85% watch without sound)",
        "Use carousel format for list-based content",
        "Include 3-5 relevant hashtags in caption",
      ],
      charLimit: 2200,
      wordsPerMinute: 170,
    },
    long: {
      structure: [
        "0-3s: HOOK — Thumb-stopping visual",
        "3-20s: INTRO — Topic + credibility",
        "20s-1m30s: CONTENT — 3-5 key points with visuals",
        "1m30s-1m50s: SUMMARY — Key takeaway",
        "1m50s-2m: CTA — Save, share, follow",
      ],
      pacingGuidelines: [
        "2-3s cuts for longer reels",
        "Use on-screen text for key stats",
        "Add captions for accessibility",
      ],
      charLimit: 2200,
      wordsPerMinute: 160,
    },
  },
  youtube: {
    short: {
      structure: [
        "0-2s: HOOK — Start mid-action or with a bold statement",
        "2-10s: SETUP — Context in under 8 seconds",
        "10-45s: CONTENT — Deliver value in tight segments",
        "45-55s: PAYOFF — Satisfying conclusion",
        "55-60s: CTA — Subscribe + next video tease",
      ],
      pacingGuidelines: [
        "2-3s cuts for Shorts",
        "Use jump cuts to maintain energy",
        "Vertical 9:16 for Shorts",
        "End card with subscribe animation",
      ],
      charLimit: 5000,
      wordsPerMinute: 170,
    },
    long: {
      structure: [
        "0-30s: HOOK + INTRO — Why watch? Promise the value.",
        "30s-2m: SETUP — Background, define the topic",
        "2m-8m: BODY — 3-5 main points with supporting visuals",
        "8m-9m: SUMMARY — Recap with on-screen bullet points",
        "9m-10m: CTA — Like, subscribe, comment question, end screen",
      ],
      pacingGuidelines: [
        "3-5s average shot length",
        "B-roll every 15-20 seconds",
        "Use chapters/timestamps in description",
        "Pattern interrupt every 30-45 seconds",
        "Include end screen with related videos",
      ],
      charLimit: 5000,
      wordsPerMinute: 150,
    },
  },
  x: {
    short: {
      structure: [
        "Line 1: HOOK — Bold claim or hot take (≤50 chars)",
        "Lines 2-3: CONTEXT — Support the hook with a fact or story",
        "Lines 4-5: VALUE — Actionable insight or unique angle",
        "Line 6: CTA — Retweet if, reply with, bookmark this",
      ],
      pacingGuidelines: [
        "280 char limit per tweet",
        "Thread format for extended content",
        "Use line breaks for readability",
        "No more than 2 hashtags",
        "Attach media for 2-3x engagement",
      ],
      charLimit: 280,
      wordsPerMinute: 200,
    },
    long: {
      structure: [
        "Tweet 1: HOOK — Pattern interrupt, the thread promise",
        "Tweets 2-8: BODY — One idea per tweet, numbered",
        "Tweet 9: SUMMARY — Key takeaway",
        "Tweet 10: CTA — Follow for more, retweet tweet 1",
      ],
      pacingGuidelines: [
        "280 chars per tweet",
        "Number each tweet (1/10, 2/10...)",
        "End each tweet with a hook to the next",
        "Pin a reply with a summary",
      ],
      charLimit: 280,
      wordsPerMinute: 200,
    },
  },
};

const getScriptTemplate = createTool({
  id: "getScriptTemplate",
  description:
    "Fetch platform-specific script structures and pacing guidelines. Returns real templates based on platform best practices.",
  inputSchema: z.object({
    platform: z.string().describe("Target platform (youtube, tiktok, instagram, x)"),
    format: z.enum(["short", "long"]).optional().describe("Short-form or long-form"),
    duration: z.number().optional().describe("Target duration in seconds"),
  }),
  execute: async (executionContext) => {
    const { platform, format, duration } = executionContext.context;
    const wrappedFn = wrapToolHandler(
      async (input: { platform: string; format?: string; duration?: number }) => {
        const platformKey = input.platform.toLowerCase();
        const formatKey = input.format ?? "short";
        const targetDuration = input.duration ?? (formatKey === "short" ? 60 : 300);

        // Look up platform template
        const platformTemplates = TEMPLATES[platformKey] ?? TEMPLATES.tiktok;
        const template = platformTemplates[formatKey] ?? platformTemplates.short;

        // Also try to load brand config for script styling
        let brandNotes: string | null = null;
        try {
          // Find first org that has brandConfig set
          const orgs = await db.organization.findMany({
            take: 10,
            select: { brandConfig: true },
          });
          const withConfig = orgs.find((o) => o.brandConfig != null);
          if (withConfig?.brandConfig) {
            const config = withConfig.brandConfig as Record<string, unknown>;
            brandNotes = (config.scriptNotes as string) ?? null;
          }
        } catch {
          // DB not available — use template defaults
        }

        return {
          platform: platformKey,
          format: formatKey,
          targetDuration,
          structure: template.structure,
          pacingGuidelines: [
            ...template.pacingGuidelines,
            ...(brandNotes ? [`BRAND: ${brandNotes}`] : []),
          ],
          charLimit: template.charLimit,
          wordsPerMinute: template.wordsPerMinute,
          estimatedWordCount: Math.round(
            (targetDuration / 60) * template.wordsPerMinute,
          ),
          status: "ok" as const,
        };
      },
      { agentName: AGENT_NAME, toolName: "getScriptTemplate" },
    );
    return wrappedFn({ platform, format, duration });
  },
});

const scriptAgent = new Agent({
  name: AGENT_NAME,
  instructions: INSTRUCTIONS,
  model: modelConfig.tier25,
  tools: { getScriptTemplate },
});

export function createAgent() {
  return scriptAgent;
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

  const result = await scriptAgent.generate(prompt, {
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
