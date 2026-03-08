// Centralized model configuration for platform agents.
// Uses type assertion — actual model provider wired at Mastra init.

import type { LanguageModelV1 } from "ai";

export const modelConfig = {
  /** Tier 2 platform main agents — higher capability */
  tier2: { provider: "openai", name: "gpt-4o" } as unknown as LanguageModelV1,
  /** Tier 2.5 sub-agents — cost-optimized */
  tier25: { provider: "openai", name: "gpt-4o-mini" } as unknown as LanguageModelV1,
};
