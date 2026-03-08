// Safety hooks called by wrapToolHandler — prevents agents from
// leaking secrets or calling tools outside their permitted scope.

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
  "quality-scorer": new Set(["getEditingRules", "getQualityThresholds"]),
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
