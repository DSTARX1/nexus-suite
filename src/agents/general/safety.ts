// Safety hooks called by wrapToolHandler — prevents agents from
// leaking secrets or calling tools outside their permitted scope.
// Also provides reply validation (profanity, brand voice, rate limiting).

import { redis } from "@/lib/redis.js";

const CREDENTIAL_PATTERNS = [
  /(?:sk|pk)[-_](?:live|test)[-_][a-zA-Z0-9]{20,}/g,       // Stripe keys
  /ghp_[a-zA-Z0-9]{36}/g,                                   // GitHub PATs
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWTs
  /AKIA[0-9A-Z]{16}/g,                                      // AWS access keys
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,               // PEM keys
  /xox[bpsa]-[a-zA-Z0-9-]{10,}/g,                           // Slack tokens
  /(?:password|secret|token|apikey|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/gi, // Generic secrets in assignments
];

const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: "[EMAIL]" },
  { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, replacement: "[PHONE]" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN]" },
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: "[CARD]" },
];

// Agent → allowed tool names. Agents not listed here have unrestricted access.
const TOOL_SCOPE: Record<string, Set<string>> = {
  "hook-writer":   new Set(["searchViralPatterns", "getWinnerLogs", "getPlatformTemplates"]),
  "seo-agent":     new Set(["tavilySearch", "youtubeSearch", "getKeywordMetrics"]),
  "caption-writer": new Set(["getCharLimits", "getBrandVoice"]),
  "hashtag-optimizer": new Set(["getTrending", "getHashtagAnalytics"]),
  "trend-scout":   new Set(["tavilySearch", "searchTwitter", "searchHackerNews", "searchReddit"]),
  "quality-scorer": new Set(["getEditingRules", "getQualityThresholds", "scoreContent"]),
  "article-writer":    new Set(["getArticleOutline"]),
  "script-agent":      new Set(["getScriptTemplate"]),
  "thread-writer":     new Set(["getThreadStructure"]),
  "title-generator":   new Set(["getTitlePerformance"]),
  "thumbnail-creator": new Set(["getThumbnailSpecs"]),
  "analytics-reporter":     new Set(["queryAnalytics"]),
  "brand-persona-agent":    new Set(["getBrandProfile"]),
  "content-repurposer":     new Set(["getPlatformFormats"]),
  "engagement-responder":   new Set(["getRecentComments", "postReply"]),
  "x-engagement-responder": new Set(["fetchMentions", "craftReply"]),
  "variation-orchestrator":  new Set(["getTransformPresets"]),
  "viral-teardown-agent":   new Set(["fetchViralContent"]),
};

/**
 * Scans output string for credential patterns.
 * Throws if any credential-like string is found.
 */
export function validateNoCredentials(output: string): void {
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(output)) {
      throw new Error("Safety: credential leak detected in tool output — blocked");
    }
  }
}

/**
 * Strips PII patterns from input string, replacing with placeholders.
 * Returns sanitized copy.
 */
export function stripPII(input: string): string {
  let sanitized = input;
  for (const { pattern, replacement } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

/**
 * Checks that agentName is allowed to call toolName.
 * Throws if tool is outside the agent's permitted scope.
 * Agents not in TOOL_SCOPE have unrestricted access.
 */
export function enforceToolScope(agentName: string, toolName: string): void {
  const allowed = TOOL_SCOPE[agentName];
  if (allowed && !allowed.has(toolName)) {
    throw new Error(
      `Safety: agent "${agentName}" is not permitted to call tool "${toolName}". Allowed: [${Array.from(allowed).join(", ")}]`,
    );
  }
}

// ── Reply Validation ────────────────────────────────────────

const PROFANITY_WORDS = new Set([
  "fuck", "shit", "ass", "bitch", "damn", "crap", "dick", "cock",
  "pussy", "bastard", "slut", "whore", "nigger", "faggot", "retard",
  "cunt", "motherfucker", "asshole", "bullshit", "horseshit",
]);

const REPLY_RATE_LIMIT_PER_HOUR = 20;
const REPLY_RATE_KEY_PREFIX = "safety:reply_rate";

export interface ReplyValidationResult {
  approved: boolean;
  reasons: string[];
}

/**
 * Validates a proposed reply before posting.
 * Checks: profanity filter, brand voice alignment, per-platform rate limit (20/hr).
 */
export async function validateReply(
  reply: string,
  platform: string,
  organizationId: string,
  brandVoice?: string,
): Promise<ReplyValidationResult> {
  const reasons: string[] = [];

  // 1. Profanity check — match whole words case-insensitively
  const words = reply.toLowerCase().split(/\W+/);
  const foundProfanity = words.filter((w) => PROFANITY_WORDS.has(w));
  if (foundProfanity.length > 0) {
    reasons.push(`Profanity detected: ${foundProfanity.join(", ")}`);
  }

  // 2. Brand voice alignment (heuristic checks)
  if (brandVoice) {
    const voiceLower = brandVoice.toLowerCase();

    // If brand voice is "professional" or "formal", flag overly casual language
    if (
      (voiceLower.includes("professional") || voiceLower.includes("formal")) &&
      /\b(lol|lmao|omg|bruh|ngl|fr|imo|tbh)\b/i.test(reply)
    ) {
      reasons.push("Reply contains casual language inconsistent with professional brand voice");
    }

    // If brand voice is "friendly" or "casual", flag overly corporate language
    if (
      (voiceLower.includes("casual") || voiceLower.includes("friendly")) &&
      /\b(pursuant|hereby|heretofore|notwithstanding|aforementioned)\b/i.test(reply)
    ) {
      reasons.push("Reply contains overly formal language inconsistent with casual brand voice");
    }
  }

  // 3. Credential/PII leak check on reply
  try {
    validateNoCredentials(reply);
  } catch {
    reasons.push("Reply contains credential-like content");
  }

  // 4. Rate limit check — 20 replies per hour per platform per org
  const rateKey = `${REPLY_RATE_KEY_PREFIX}:${organizationId}:${platform}`;
  const currentCount = await redis.get(rateKey);
  const used = currentCount ? parseInt(currentCount, 10) : 0;

  if (used >= REPLY_RATE_LIMIT_PER_HOUR) {
    reasons.push(
      `Rate limit exceeded: ${used}/${REPLY_RATE_LIMIT_PER_HOUR} replies this hour on ${platform}`,
    );
  }

  return {
    approved: reasons.length === 0,
    reasons,
  };
}

/**
 * Increment the reply rate counter after a successful reply post.
 * Counter auto-expires after 1 hour.
 */
export async function incrementReplyRate(
  platform: string,
  organizationId: string,
): Promise<void> {
  const rateKey = `${REPLY_RATE_KEY_PREFIX}:${organizationId}:${platform}`;
  const pipeline = redis.pipeline();
  pipeline.incr(rateKey);
  pipeline.expire(rateKey, 3600); // 1 hour TTL
  await pipeline.exec();
}
