import type { WorkflowContext } from "./control-flow";
import { trackLlmSpend } from "../services/llm-budget";
import type { WrappedToolResult } from "@/agents/general/cli-tool-wrappers";

// Agent registry: maps agent name → generate function + optional tools
// Populated at startup when Mastra agents are initialized
type AgentGenerateFn = (
  prompt: string,
  opts?: { model?: string; maxTokens?: number },
) => Promise<AgentResult>;

// Mastra tool shape (from createTool)
interface MastraTool {
  id: string;
  description: string;
  execute: (input: unknown) => Promise<WrappedToolResult>;
}

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
  toolsMeta?: Array<{ id: string; description: string }>;
}

interface RegisteredAgent {
  generateFn: AgentGenerateFn;
  tools: MastraTool[];
}

const agentRegistry = new Map<string, RegisteredAgent>();

export function getRegisteredAgents(): ReadonlyMap<string, RegisteredAgent> {
  return agentRegistry;
}

export function registerAgent(
  name: string,
  generateFn: AgentGenerateFn,
  tools: MastraTool[] = [],
) {
  agentRegistry.set(name, { generateFn, tools });
}

// Client plugin resolution order:
// 1. src/agents/clients/{orgId}/agents/{agentName}
// 2. src/agents/platforms/{platform}/subagents/{agentName}
// 3. src/agents/specialists/{agentName}
// 4. Global agent registry (registered at startup)
function resolveAgent(agentName: string, _orgId: string): RegisteredAgent | null {
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
  const entry = resolveAgent(agentName, context.organizationId);

  if (!entry) {
    throw new Error(
      `Agent "${agentName}" not found. Available: [${Array.from(agentRegistry.keys()).join(", ")}]`,
    );
  }

  const result = await entry.generateFn(prompt, { model, maxTokens });

  // Track LLM spend if usage data is available
  if (result.usage) {
    await trackLlmSpend(
      context.organizationId,
      result.usage.model,
      result.usage.promptTokens,
      result.usage.completionTokens,
    );
  }

  // Attach tool metadata so callers know which tools were available
  const toolsMeta = entry.tools.map((t) => ({
    id: t.id,
    description: t.description,
  }));

  return {
    text: result.text,
    toolCalls: result.toolCalls,
    toolsMeta,
  };
}
