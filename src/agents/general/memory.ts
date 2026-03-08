import type { WorkflowContext } from "@/server/workflows/control-flow";

// ── Field allowlists per agent type ──────────────────────────────
// Data minimization: agents only see what they need.

const AGENT_FIELD_ALLOWLIST: Record<string, string[]> = {
  "content-writer": ["organizationId", "brandVoice", "topic", "platform", "contentType", "instructions"],
  "analytics": ["organizationId", "platform", "metric", "period", "accountId"],
  "scheduler": ["organizationId", "posts", "timezone", "schedule"],
  "moderator": ["organizationId", "content", "platform", "communityGuidelines"],
  // Default: minimal set for unknown agents
  default: ["organizationId"],
};

/**
 * Strip workflow context to only fields the target agent needs.
 * Implements data minimization from ARCHITECTURE.md.
 *
 * Takes full context.variables + context.input and returns
 * a filtered record containing only allowed fields for the agent.
 */
export function prepareContext(
  agentName: string,
  context: WorkflowContext,
): Record<string, unknown> {
  const allowedFields =
    AGENT_FIELD_ALLOWLIST[agentName] ?? AGENT_FIELD_ALLOWLIST.default;

  const merged: Record<string, unknown> = {
    ...context.input,
    ...context.variables,
    organizationId: context.organizationId,
  };

  const stripped: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (field in merged) {
      stripped[field] = merged[field];
    }
  }

  return stripped;
}

// ── Context Window Management ────────────────────────────────────

const DEFAULT_MAX_CONTEXT_CHARS = 100_000;

interface ContextEntry {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: number;
}

/**
 * Trim conversation history to fit within context window limits.
 * Keeps system messages + most recent entries, drops oldest user/assistant pairs.
 */
export function trimContextWindow(
  entries: ContextEntry[],
  maxChars: number = DEFAULT_MAX_CONTEXT_CHARS,
): ContextEntry[] {
  // Always keep system messages
  const system = entries.filter((e) => e.role === "system");
  const nonSystem = entries.filter((e) => e.role !== "system");

  let totalChars = system.reduce((sum, e) => sum + e.content.length, 0);

  // Add non-system entries from most recent, stop when budget exhausted
  const kept: ContextEntry[] = [];
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const entry = nonSystem[i];
    if (totalChars + entry.content.length > maxChars) break;
    totalChars += entry.content.length;
    kept.unshift(entry);
  }

  return [...system, ...kept];
}

/**
 * Summarize a long text to reduce token usage before sending to agent.
 * Simple truncation with marker — replace with LLM summarization in production.
 */
export function summarizeForContext(
  text: string,
  maxLength: number = 4000,
): string {
  if (text.length <= maxLength) return text;
  const half = Math.floor(maxLength / 2);
  return (
    text.slice(0, half) +
    "\n\n[…content truncated for context window…]\n\n" +
    text.slice(-half)
  );
}
