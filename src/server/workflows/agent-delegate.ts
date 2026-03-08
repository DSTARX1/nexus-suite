import type { WorkflowContext } from "./control-flow";
import { trackLlmSpend } from "../services/llm-budget";

// Agent registry: maps agent name → generate function
// Populated at startup when Mastra agents are initialized
type AgentGenerateFn = (
  prompt: string,
  opts?: { model?: string; maxTokens?: number },
) => Promise<AgentResult>;

interface AgentResult {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    model: string;
  };
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
}

const agentRegistry = new Map<string, AgentGenerateFn>();

export function registerAgent(name: string, generateFn: AgentGenerateFn) {
  agentRegistry.set(name, generateFn);
}

// Client plugin resolution order:
// 1. src/agents/clients/{orgId}/agents/{agentName}
// 2. src/agents/platforms/{platform}/subagents/{agentName}
// 3. src/agents/specialists/{agentName}
// 4. Global agent registry (registered at startup)
function resolveAgent(agentName: string, _orgId: string): AgentGenerateFn | null {
  // TODO: Phase 3 will implement dynamic client plugin loading
  // For now, use the global registry
  return agentRegistry.get(agentName) ?? null;
}

export async function executeAgentDelegate(
  agentName: string,
  prompt: string,
  context: WorkflowContext,
  model?: string,
  maxTokens?: number,
): Promise<unknown> {
  const agent = resolveAgent(agentName, context.organizationId);

  if (!agent) {
    throw new Error(
      `Agent "${agentName}" not found. Available: [${Array.from(agentRegistry.keys()).join(", ")}]`,
    );
  }

  const result = await agent(prompt, { model, maxTokens });

  // Track LLM spend if usage data is available
  if (result.usage) {
    await trackLlmSpend(
      context.organizationId,
      result.usage.model,
      result.usage.promptTokens,
      result.usage.completionTokens,
    );
  }

  return {
    text: result.text,
    toolCalls: result.toolCalls,
  };
}
