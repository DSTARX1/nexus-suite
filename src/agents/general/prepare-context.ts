// Data minimization per Decision 3 — each agent receives ONLY the fields it needs.
// Takes full workflow context + agent name → returns stripped context.

interface FullContext {
  organizationId: string;
  workflowName: string;
  runId: string;
  input: Record<string, unknown>;
  variables: Record<string, unknown>;
  config: Record<string, unknown>;
  [key: string]: unknown;
}

type StrippedContext = Record<string, unknown>;

// Per-agent whitelists — keys allowed from the full context.
// Agents not listed here receive: organizationId + input + variables only.
const AGENT_WHITELISTS: Record<string, readonly string[]> = {
  // Tier 1
  "orchestrator":        ["organizationId", "workflowName", "runId", "input", "variables", "config"],
  "workflow-agent":      ["organizationId", "workflowName", "runId", "input", "variables", "config"],

  // Tier 2 — platform mains get org + input + variables (no raw config)
  "youtube-main":        ["organizationId", "input", "variables"],
  "tiktok-main":         ["organizationId", "input", "variables"],
  "instagram-main":      ["organizationId", "input", "variables"],
  "linkedin-main":       ["organizationId", "input", "variables"],
  "x-main":              ["organizationId", "input", "variables"],
  "facebook-main":       ["organizationId", "input", "variables"],

  // Tier 3 specialists — minimal: org + input only
  "seo-agent":           ["organizationId", "input"],
  "hook-writer":         ["organizationId", "input"],
  "title-generator":     ["organizationId", "input"],
  "thumbnail-creator":   ["organizationId", "input"],
  "script-agent":        ["organizationId", "input"],
  "caption-writer":      ["organizationId", "input"],
  "hashtag-optimizer":   ["organizationId", "input"],
  "thread-writer":       ["organizationId", "input"],
  "article-writer":      ["organizationId", "input"],
  "trend-scout":         ["organizationId", "input"],
  "engagement-responder": ["organizationId", "input"],
  "analytics-reporter":  ["organizationId", "input"],
  "content-repurposer":  ["organizationId", "input"],
  "quality-scorer":      ["organizationId", "input"],
  "variation-orchestrator": ["organizationId", "input"],
  "brand-persona":       ["organizationId", "input"],
  "viral-teardown":      ["organizationId", "input"],

  // Tier 2.5 sub-agents — same as specialists
  "news-scout":          ["organizationId", "input"],
  "tone-translator":     ["organizationId", "input"],
  "x-engagement-responder": ["organizationId", "input"],
  "community-post-formatter": ["organizationId", "input"],
  "shorts-optimizer":    ["organizationId", "input"],
  "duet-stitch-logic":   ["organizationId", "input"],
  "sound-selector":      ["organizationId", "input"],
  "carousel-sequencer":  ["organizationId", "input"],
  "story-formatter":     ["organizationId", "input"],
  "professional-tone-adapter": ["organizationId", "input"],
  "article-formatter":   ["organizationId", "input"],
};

const DEFAULT_WHITELIST: readonly string[] = ["organizationId", "input", "variables"];

/**
 * Strips workflow context down to only the fields the target agent needs.
 * Prevents agents from accessing config, secrets references, or
 * workflow internals beyond their scope.
 */
export function prepareContext(fullContext: FullContext, agentName: string): StrippedContext {
  const whitelist = AGENT_WHITELISTS[agentName] ?? DEFAULT_WHITELIST;
  const stripped: StrippedContext = {};

  for (const key of whitelist) {
    if (key in fullContext) {
      stripped[key] = fullContext[key];
    }
  }

  return stripped;
}
