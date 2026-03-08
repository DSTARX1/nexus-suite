// ── Shared Prompt Templates ──────────────────────────────────────
// Template functions accept org context and return formatted prompts.

interface OrgContext {
  organizationId: string;
  orgName: string;
  brandVoice?: string;
  industry?: string;
}

/**
 * System prompt enforcing data minimization.
 * Injected into every agent to prevent leaking org data across boundaries.
 */
export function dataMinimizationPrompt(ctx: OrgContext): string {
  return [
    "You are operating on behalf of a specific organization.",
    `Organization: ${ctx.orgName} (ID: ${ctx.organizationId})`,
    "",
    "DATA MINIMIZATION RULES:",
    "- Only use data explicitly provided in this conversation context.",
    "- Never reference data from other organizations or sessions.",
    "- Do not store, cache, or log sensitive information (tokens, passwords, PII).",
    "- Strip any credentials or secrets from your output.",
    "- If you need data not provided, request it explicitly — do not infer or fabricate.",
  ].join("\n");
}

/**
 * Brand voice injection template.
 * Adjusts agent tone/style to match org brand guidelines.
 */
export function brandVoicePrompt(ctx: OrgContext): string {
  if (!ctx.brandVoice) return "";

  return [
    "",
    "BRAND VOICE GUIDELINES:",
    `Industry: ${ctx.industry ?? "general"}`,
    `Voice: ${ctx.brandVoice}`,
    "- Match this tone in all user-facing content.",
    "- Maintain consistency across posts, replies, and reports.",
  ].join("\n");
}

/**
 * Tool usage instructions for agents with CLI bridge tools.
 */
export function toolUsagePrompt(availableTools: string[]): string {
  if (availableTools.length === 0) return "";

  return [
    "",
    "AVAILABLE TOOLS:",
    ...availableTools.map((t) => `- ${t}`),
    "",
    "TOOL USAGE RULES:",
    "- Use tools only when necessary to fulfill the request.",
    "- Validate tool inputs before calling — do not pass empty or malformed data.",
    "- If a tool call fails, report the error clearly — do not retry silently.",
    "- Respect rate limits. If rate-limited, inform the user and wait.",
  ].join("\n");
}

/**
 * Compose a full system prompt from org context + available tools.
 */
export function composeSystemPrompt(
  ctx: OrgContext,
  availableTools: string[] = [],
): string {
  return [
    dataMinimizationPrompt(ctx),
    brandVoicePrompt(ctx),
    toolUsagePrompt(availableTools),
  ]
    .filter(Boolean)
    .join("\n");
}
