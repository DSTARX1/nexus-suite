import { createTRPCRouter, onboardedProcedure } from "../trpc";
import { getRegisteredAgents } from "@/server/workflows/agent-delegate";

// ── Tier classification ─────────────────────────────────────────

type Tier = 1 | 2 | 3;

const TIER_1_NAMES = new Set(["nexus-orchestrator", "workflow-agent"]);

function classifyTier(name: string): Tier {
  if (TIER_1_NAMES.has(name)) return 1;
  if (name.endsWith("-agent")) return 2;
  return 3;
}

// ── Router ──────────────────────────────────────────────────────

export const agentsRouter = createTRPCRouter({
  list: onboardedProcedure.query(() => {
    const registry = getRegisteredAgents();
    return Array.from(registry.keys()).map((name) => ({
      name,
      tier: classifyTier(name),
    }));
  }),
});
