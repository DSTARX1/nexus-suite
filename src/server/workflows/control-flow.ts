import type {
  Step,
  ConditionStep,
  ForEachStep,
  WhileStep,
  ParallelStep,
} from "./workflow-schema";
import { interpolate } from "./interpolation";

export interface StepResult {
  stepId: string;
  status: "success" | "error" | "skipped";
  output?: unknown;
  error?: string;
  durationMs: number;
}

export type StepExecutor = (step: Step, context: WorkflowContext) => Promise<StepResult>;

export interface WorkflowContext {
  organizationId: string;
  workflowName: string;
  runId: string;
  variables: Record<string, unknown>;
  config: Record<string, unknown>;
  input: Record<string, unknown>;
  aborted: boolean;
  abortReason?: string;
}

// ── Condition Step ───────────────────────────────────────────────

export async function executeCondition(
  step: ConditionStep,
  context: WorkflowContext,
  executor: StepExecutor,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const start = Date.now();

  const resolved = interpolate(step.condition, context.variables);
  const conditionMet = evaluateCondition(resolved);

  const branch = conditionMet ? step.onTrue : (step.onFalse ?? []);

  for (const child of branch) {
    if (context.aborted) break;
    const result = await executor(child, context);
    results.push(result);
    if ((child as any).outputAs && result.output !== undefined) {
      context.variables[(child as any).outputAs] = result.output;
    }
  }

  results.unshift({
    stepId: step.id,
    status: "success",
    output: { conditionMet, branch: conditionMet ? "onTrue" : "onFalse" },
    durationMs: Date.now() - start,
  });

  return results;
}

// ── ForEach Step ─────────────────────────────────────────────────

export async function executeForEach(
  step: ForEachStep,
  context: WorkflowContext,
  executor: StepExecutor,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const start = Date.now();

  const collectionRef = interpolate(step.collection, context.variables);
  const collection = resolveValue(collectionRef, context.variables);

  if (!Array.isArray(collection)) {
    return [{
      stepId: step.id,
      status: "error",
      error: `forEach collection resolved to non-array: ${typeof collection}`,
      durationMs: Date.now() - start,
    }];
  }

  const maxConcurrency = step.maxConcurrency ?? collection.length;
  const iterationOutputs: unknown[] = [];

  // Process in batches of maxConcurrency
  for (let i = 0; i < collection.length; i += maxConcurrency) {
    if (context.aborted) break;

    const batch = collection.slice(i, i + maxConcurrency);
    const batchPromises = batch.map(async (item, batchIdx) => {
      const iterIndex = i + batchIdx;
      // Create scoped context with iteration variable
      const scopedVars = {
        ...context.variables,
        [step.as]: item,
        [`${step.as}Index`]: iterIndex,
      };
      const scopedContext = { ...context, variables: scopedVars };

      const iterResults: StepResult[] = [];
      for (const child of step.steps) {
        if (context.aborted) break;
        const result = await executor(child, scopedContext);
        iterResults.push(result);
        if ((child as any).outputAs && result.output !== undefined) {
          scopedContext.variables[(child as any).outputAs] = result.output;
        }
      }
      return { iterResults, lastOutput: iterResults[iterResults.length - 1]?.output };
    });

    const batchResults = await Promise.allSettled(batchPromises);
    for (const settled of batchResults) {
      if (settled.status === "fulfilled") {
        results.push(...settled.value.iterResults);
        iterationOutputs.push(settled.value.lastOutput);
      } else {
        results.push({
          stepId: `${step.id}[batch]`,
          status: "error",
          error: String(settled.reason),
          durationMs: 0,
        });
      }
    }
  }

  // Store collected outputs
  if (step.outputAs) {
    context.variables[step.outputAs] = iterationOutputs;
  }

  results.unshift({
    stepId: step.id,
    status: context.aborted ? "skipped" : "success",
    output: { iterations: collection.length, collected: iterationOutputs.length },
    durationMs: Date.now() - start,
  });

  return results;
}

// ── While Step ───────────────────────────────────────────────────

export async function executeWhile(
  step: WhileStep,
  context: WorkflowContext,
  executor: StepExecutor,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const start = Date.now();
  let iteration = 0;

  while (iteration < step.maxIterations && !context.aborted) {
    const resolved = interpolate(step.condition, context.variables);
    if (!evaluateCondition(resolved)) break;

    for (const child of step.steps) {
      if (context.aborted) break;
      const result = await executor(child, context);
      results.push(result);
      if ((child as any).outputAs && result.output !== undefined) {
        context.variables[(child as any).outputAs] = result.output;
      }
    }
    iteration++;
  }

  results.unshift({
    stepId: step.id,
    status: "success",
    output: { iterations: iteration, maxReached: iteration >= step.maxIterations },
    durationMs: Date.now() - start,
  });

  return results;
}

// ── Parallel Step ────────────────────────────────────────────────

export async function executeParallel(
  step: ParallelStep,
  context: WorkflowContext,
  executor: StepExecutor,
): Promise<StepResult[]> {
  const start = Date.now();

  // All child steps run concurrently via Promise.allSettled
  const promises = step.steps.map((child) => executor(child, context));
  const settled = await Promise.allSettled(promises);

  const results: StepResult[] = [];

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const child = step.steps[i];

    if (s.status === "fulfilled") {
      results.push(s.value);
      if ((child as any).outputAs && s.value.output !== undefined) {
        context.variables[(child as any).outputAs] = s.value.output;
      }
    } else {
      results.push({
        stepId: child.id,
        status: "error",
        error: String(s.reason),
        durationMs: 0,
      });
    }
  }

  results.unshift({
    stepId: step.id,
    status: results.every((r) => r.status === "success") ? "success" : "error",
    output: { parallelCount: step.steps.length },
    durationMs: Date.now() - start,
  });

  return results;
}

// ── Expression Evaluation ────────────────────────────────────────

function evaluateCondition(expression: string): boolean {
  // Supports: ==, !=, >=, <=, >, <, &&, ||, true, false
  const cleaned = expression.trim();

  if (cleaned === "true") return true;
  if (cleaned === "false") return false;

  // Numeric comparisons
  const compMatch = cleaned.match(/^(.+?)\s*(>=|<=|!=|==|>|<)\s*(.+)$/);
  if (compMatch) {
    const [, left, op, right] = compMatch;
    const lVal = parseNumOrString(left.trim());
    const rVal = parseNumOrString(right.trim());

    switch (op) {
      case "==": return lVal == rVal;
      case "!=": return lVal != rVal;
      case ">=": return Number(lVal) >= Number(rVal);
      case "<=": return Number(lVal) <= Number(rVal);
      case ">": return Number(lVal) > Number(rVal);
      case "<": return Number(lVal) < Number(rVal);
    }
  }

  // Truthy check: non-empty string, non-zero number
  if (cleaned.length > 0 && cleaned !== "0" && cleaned !== "null" && cleaned !== "undefined") {
    return true;
  }

  return false;
}

function parseNumOrString(val: string): number | string {
  const num = Number(val);
  return isNaN(num) ? val.replace(/^["']|["']$/g, "") : num;
}

function resolveValue(ref: string, variables: Record<string, unknown>): unknown {
  // Handle direct variable reference (already interpolated)
  if (ref in variables) return variables[ref];

  // Handle dot-path resolution
  const parts = ref.split(".");
  let current: unknown = variables;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return ref;
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? ref;
}
