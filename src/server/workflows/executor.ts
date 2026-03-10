import { parse as parseYaml } from "yaml";
import type {
  WorkflowDefinition,
  Step,
  ActionStep,
  AgentDelegateStep,
} from "./workflow-schema";
import {
  type StepResult,
  type WorkflowContext,
  type StepExecutor,
  executeCondition,
  executeForEach,
  executeWhile,
  executeParallel,
} from "./control-flow";
import { interpolate, interpolateParams } from "./interpolation";
import { validateWorkflow } from "./validator";
import { executeAgentDelegate } from "./agent-delegate";
import { checkLlmBudget } from "../services/llm-budget";
import { randomUUID } from "crypto";

export interface WorkflowRunResult {
  runId: string;
  workflowName: string;
  organizationId: string;
  status: "completed" | "failed" | "aborted";
  reproduction?: boolean;
  steps: StepResult[];
  variables: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  error?: string;
}

// Module registry: maps "service.method" → handler
export type ActionHandler = (
  params: Record<string, unknown>,
  context: WorkflowContext,
) => Promise<unknown>;

const actionRegistry = new Map<string, ActionHandler>();

export function registerAction(name: string, handler: ActionHandler) {
  actionRegistry.set(name, handler);
}

// ── Main Executor ────────────────────────────────────────────────

export async function executeWorkflow(
  definition: WorkflowDefinition | string,
  inputData?: Record<string, unknown>,
): Promise<WorkflowRunResult> {
  // Parse YAML if string
  const workflow: WorkflowDefinition =
    typeof definition === "string" ? parseYaml(definition) : definition;

  // Validate
  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    throw new Error(
      `Workflow validation failed:\n${validation.errors.map((e) => `  [${e.layer}] ${e.path}: ${e.message}`).join("\n")}`,
    );
  }

  const runId = randomUUID();
  const startedAt = new Date();

  const context: WorkflowContext = {
    organizationId: workflow.organizationId,
    workflowName: workflow.name,
    runId,
    variables: {},
    config: (workflow.config ?? {}) as Record<string, unknown>,
    input: inputData ?? {},
    aborted: false,
  };

  // Merge config and input into variables for interpolation access
  context.variables.config = context.config;
  context.variables.input = context.input;

  const allResults: StepResult[] = [];

  try {
    // Build dependency graph → execute in waves
    const waves = buildExecutionWaves(workflow.steps);

    for (const wave of waves) {
      if (context.aborted) break;

      if (wave.length === 1) {
        // Single step — execute sequentially
        const result = await executeStep(wave[0], context);
        if (Array.isArray(result)) {
          allResults.push(...result);
        } else {
          allResults.push(result);
          // Store output
          if (wave[0].outputAs && result.output !== undefined) {
            context.variables[wave[0].outputAs] = result.output;
          }
        }
      } else {
        // Multiple steps with no inter-dependencies — execute in parallel
        const promises = wave.map((step) => executeStep(step, context));
        const settled = await Promise.allSettled(promises);

        for (let i = 0; i < settled.length; i++) {
          const s = settled[i];
          const step = wave[i];
          if (s.status === "fulfilled") {
            if (Array.isArray(s.value)) {
              allResults.push(...s.value);
            } else {
              allResults.push(s.value);
              if (step.outputAs && s.value.output !== undefined) {
                context.variables[step.outputAs] = s.value.output;
              }
            }
          } else {
            allResults.push({
              stepId: step.id,
              status: "error",
              error: String(s.reason),
              durationMs: 0,
            });
          }
        }
      }
    }
  } catch (err) {
    const completedAt = new Date();
    return {
      runId,
      workflowName: workflow.name,
      organizationId: workflow.organizationId,
      status: "failed",
      steps: allResults,
      variables: context.variables,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      error: String(err),
    };
  }

  const completedAt = new Date();
  const hasErrors = allResults.some((r) => r.status === "error");

  // Detect reproduction workflows from input flags or workflow config
  const isReproduction =
    inputData?.reproduction === true ||
    (workflow.config as Record<string, unknown> | undefined)?.reproduction === true;

  return {
    runId,
    workflowName: workflow.name,
    organizationId: workflow.organizationId,
    status: context.aborted ? "aborted" : hasErrors ? "failed" : "completed",
    reproduction: isReproduction || undefined,
    steps: allResults,
    variables: context.variables,
    startedAt,
    completedAt,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    error: context.abortReason,
  };
}

// ── Step Dispatcher ──────────────────────────────────────────────

async function executeStep(
  step: Step,
  context: WorkflowContext,
): Promise<StepResult | StepResult[]> {
  if (context.aborted) {
    return { stepId: step.id, status: "skipped", durationMs: 0 };
  }

  switch (step.type) {
    case "action":
      return executeAction(step, context);

    case "agent-delegate":
      return executeAgentDelegateStep(step, context);

    case "condition":
      return executeCondition(step, context, executeStep as StepExecutor);

    case "forEach":
      return executeForEach(step, context, executeStep as StepExecutor);

    case "while":
      return executeWhile(step, context, executeStep as StepExecutor);

    case "parallel":
      return executeParallel(step, context, executeStep as StepExecutor);

    default:
      return {
        stepId: step.id,
        status: "error",
        error: `Unknown step type: ${(step as any).type}`,
        durationMs: 0,
      };
  }
}

// ── Action Step ──────────────────────────────────────────────────

async function executeAction(step: ActionStep, context: WorkflowContext): Promise<StepResult> {
  const start = Date.now();

  const handler = actionRegistry.get(step.action);
  if (!handler) {
    return {
      stepId: step.id,
      status: "error",
      error: `No action handler registered for "${step.action}"`,
      durationMs: Date.now() - start,
    };
  }

  const params = step.params
    ? interpolateParams(step.params, context.variables)
    : {};

  let lastError: string | undefined;
  const maxAttempts = (step.retries ?? 0) + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await withTimeout(
        handler(params, context),
        step.timeoutMs ?? 300_000, // 5min default
      );

      return {
        stepId: step.id,
        status: "success",
        output,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      lastError = String(err);
      if (attempt < maxAttempts) {
        // Exponential backoff: 1s, 2s, 4s...
        await sleep(Math.pow(2, attempt - 1) * 1000);
      }
    }
  }

  return {
    stepId: step.id,
    status: "error",
    error: lastError,
    durationMs: Date.now() - start,
  };
}

// ── Agent Delegate Step (with LLM budget check) ──────────────────

async function executeAgentDelegateStep(
  step: AgentDelegateStep,
  context: WorkflowContext,
): Promise<StepResult> {
  const start = Date.now();

  // Pre-flight LLM budget check (Decision 10 enforcement point)
  const budgetCheck = await checkLlmBudget(context.organizationId);
  if (!budgetCheck.allowed) {
    context.aborted = true;
    context.abortReason = `LLM_BUDGET_EXCEEDED: ${budgetCheck.message}`;
    return {
      stepId: step.id,
      status: "error",
      error: context.abortReason,
      durationMs: Date.now() - start,
    };
  }

  const resolvedPrompt = interpolate(step.prompt, context.variables);

  try {
    const output = await executeAgentDelegate(
      step.agent,
      resolvedPrompt,
      context,
      step.model,
      step.maxTokens,
    );

    return {
      stepId: step.id,
      status: "success",
      output,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      stepId: step.id,
      status: "error",
      error: String(err),
      durationMs: Date.now() - start,
    };
  }
}

// ── Dependency Graph → Wave Decomposition ────────────────────────

function buildExecutionWaves(steps: Step[]): Step[][] {
  const waves: Step[][] = [];
  const completed = new Set<string>();
  const remaining = [...steps];

  while (remaining.length > 0) {
    const wave: Step[] = [];
    const waveIds: string[] = [];

    for (let i = remaining.length - 1; i >= 0; i--) {
      const step = remaining[i];
      const deps = step.dependsOn ?? [];
      const allDepsMet = deps.every((d: string) => completed.has(d));

      if (allDepsMet) {
        wave.push(step);
        waveIds.push(step.id);
        remaining.splice(i, 1);
      }
    }

    if (wave.length === 0 && remaining.length > 0) {
      // Deadlock: remaining steps have unresolvable dependencies
      throw new Error(
        `Deadlock: steps [${remaining.map((s) => s.id).join(", ")}] have unresolvable dependencies`,
      );
    }

    for (const id of waveIds) completed.add(id);
    waves.push(wave);
  }

  return waves;
}

// ── Utilities ────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Step timed out after ${ms}ms`)), ms);
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
