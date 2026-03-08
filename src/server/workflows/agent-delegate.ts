import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkflowContext } from "./control-flow";
import { trackLlmSpend } from "../services/llm-budget";
import { CLIENT_PLUGIN_WHITELIST } from "@/agents/general/prepare-context";
import type { WrappedToolResult } from "@/agents/general/cli-tool-wrappers";

// AsyncLocalStorage to thread WorkflowContext through agent tool execution
const workflowContextStorage = new AsyncLocalStorage<WorkflowContext>();

/** Retrieve the current WorkflowContext from within a tool's execute function. */
export function getWorkflowContext(): WorkflowContext {
  const ctx = workflowContextStorage.getStore();
  if (!ctx) {
    throw new Error("getWorkflowContext() called outside of executeAgentDelegate — no WorkflowContext available");
  }
  return ctx;
}

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
// Known sub-agent names grouped by platform for resolution tier 2
const PLATFORM_SUBAGENTS = new Set([
  "community-post-formatter", "shorts-optimizer",
  "duet-stitch-logic", "sound-selector",
  "carousel-sequencer", "story-formatter",
  "professional-tone-adapter", "article-formatter",
  "news-scout", "tone-translator", "x-engagement-responder",
]);

// Known specialist names for resolution tier 3
const SPECIALIST_AGENTS = new Set([
  "seo-agent", "hook-writer", "title-generator", "thumbnail-creator",
  "script-agent", "caption-writer", "hashtag-optimizer", "thread-writer",
  "article-writer", "trend-scout", "engagement-responder",
  "analytics-reporter", "content-repurposer", "quality-scorer",
  "variation-orchestrator", "brand-persona-agent", "viral-teardown-agent",
]);

// Cache for dynamically loaded client plugins: "orgId::agentName" → RegisteredAgent
const clientPluginCache = new Map<string, RegisteredAgent>();

async function loadClientPlugin(
  orgId: string,
  agentName: string,
): Promise<RegisteredAgent | null> {
  const cacheKey = `${orgId}::${agentName}`;
  const cached = clientPluginCache.get(cacheKey);
  if (cached) return cached;

  const pluginPath = resolve(
    process.cwd(),
    "src/agents/clients",
    orgId,
    "agents",
    `${agentName}.ts`,
  );

  if (!existsSync(pluginPath)) return null;

  const mod: Record<string, unknown> = await import(pluginPath);

  if (typeof mod.generate !== "function") {
    throw new Error(
      `Client plugin "${pluginPath}" must export a "generate" function matching AgentGenerateFn`,
    );
  }

  const entry: RegisteredAgent = {
    generateFn: mod.generate as AgentGenerateFn,
    tools: [],
  };
  clientPluginCache.set(cacheKey, entry);
  return entry;
}

interface ResolvedAgent {
  entry: RegisteredAgent;
  isClientPlugin: boolean;
}

async function resolveAgent(agentName: string, orgId: string): Promise<ResolvedAgent | null> {
  // Resolution order:
  // 1. Client plugin: src/agents/clients/{orgId}/agents/{agentName}
  const clientPlugin = await loadClientPlugin(orgId, agentName);
  if (clientPlugin) return { entry: clientPlugin, isClientPlugin: true };

  // 2. Platform sub-agent
  if (PLATFORM_SUBAGENTS.has(agentName)) {
    const agent = agentRegistry.get(agentName);
    return agent ? { entry: agent, isClientPlugin: false } : null;
  }

  // 3. Specialist agent
  if (SPECIALIST_AGENTS.has(agentName)) {
    const agent = agentRegistry.get(agentName);
    return agent ? { entry: agent, isClientPlugin: false } : null;
  }

  // 4. Global registry fallback
  const agent = agentRegistry.get(agentName);
  return agent ? { entry: agent, isClientPlugin: false } : null;
}

export async function executeAgentDelegate(
  agentName: string,
  prompt: string,
  context: WorkflowContext,
  model?: string,
  maxTokens?: number,
): Promise<unknown> {
  const resolved = await resolveAgent(agentName, context.organizationId);

  if (!resolved) {
    throw new Error(
      `Agent "${agentName}" not found. Available: [${Array.from(agentRegistry.keys()).join(", ")}]`,
    );
  }

  const { entry, isClientPlugin } = resolved;

  // Client plugins receive a sandboxed context — only CLIENT_PLUGIN_WHITELIST keys.
  // This prevents client code from accessing Infisical config, variables, or other sensitive data.
  const sandboxedContext: WorkflowContext = isClientPlugin
    ? (Object.fromEntries(
        CLIENT_PLUGIN_WHITELIST
          .filter((k) => k in context)
          .map((k) => [k, context[k as keyof WorkflowContext]]),
      ) as unknown as WorkflowContext)
    : context;

  const result = await workflowContextStorage.run(sandboxedContext, () =>
    entry.generateFn(prompt, { model, maxTokens }),
  );

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
