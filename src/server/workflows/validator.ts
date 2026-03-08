import { workflowSchema, type WorkflowDefinition, type Step } from "./workflow-schema";
import { parse as parseYaml } from "yaml";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
}

export interface ValidationError {
  layer: string;
  path: string;
  message: string;
}

// 12-layer validation (adapted from b0t)
export function validateWorkflow(raw: string | object): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  // Layer 1: Parse YAML
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      errors.push({ layer: "yaml-parse", path: "/", message: `Invalid YAML: ${err}` });
      return { valid: false, errors, warnings };
    }
  } else {
    parsed = raw;
  }

  // Layer 2: Zod schema validation
  const result = workflowSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        layer: "schema",
        path: issue.path.join("."),
        message: issue.message,
      });
    }
    return { valid: false, errors, warnings };
  }

  const workflow = result.data;

  // Layer 3: Step ID uniqueness
  const allIds = collectStepIds(workflow.steps);
  const seen = new Set<string>();
  for (const id of allIds) {
    if (seen.has(id)) {
      errors.push({ layer: "uniqueness", path: id, message: `Duplicate step ID: "${id}"` });
    }
    seen.add(id);
  }

  // Layer 4: Dependency graph validation (no missing refs)
  for (const step of flattenSteps(workflow.steps)) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!seen.has(dep)) {
          errors.push({
            layer: "dependency",
            path: step.id,
            message: `Step "${step.id}" depends on unknown step "${dep}"`,
          });
        }
      }
    }
  }

  // Layer 5: Circular dependency detection
  const cycleError = detectCycles(workflow.steps);
  if (cycleError) {
    errors.push({ layer: "cycle", path: cycleError, message: `Circular dependency detected: ${cycleError}` });
  }

  // Layer 6: Variable reference validation
  const definedOutputs = new Set<string>();
  if (workflow.config) definedOutputs.add("config");
  if (workflow.input) {
    for (const key of Object.keys(workflow.input)) {
      definedOutputs.add(`input.${key}`);
    }
  }
  for (const step of flattenSteps(workflow.steps)) {
    if (step.outputAs) definedOutputs.add(step.outputAs);
  }
  const varRefs = collectVariableRefs(workflow.steps);
  for (const { ref, stepId } of varRefs) {
    const rootVar = ref.split(".")[0].split("[")[0];
    if (!definedOutputs.has(rootVar) && rootVar !== "config" && rootVar !== "input") {
      warnings.push(`Step "${stepId}" references "{{${ref}}}" but no step outputs "${rootVar}"`);
    }
  }

  // Layer 7: Agent-delegate validation
  for (const step of flattenSteps(workflow.steps)) {
    if (step.type === "agent-delegate") {
      if (!step.prompt || step.prompt.trim().length === 0) {
        errors.push({ layer: "agent", path: step.id, message: "agent-delegate step requires non-empty prompt" });
      }
    }
  }

  // Layer 8: Parallel step nesting (warn on deeply nested parallels)
  const maxDepth = measureParallelDepth(workflow.steps);
  if (maxDepth > 3) {
    warnings.push(`Parallel nesting depth is ${maxDepth} — may cause resource contention`);
  }

  // Layer 9: ForEach without maxConcurrency warning
  for (const step of flattenSteps(workflow.steps)) {
    if (step.type === "forEach" && !step.maxConcurrency) {
      warnings.push(`forEach step "${step.id}" has no maxConcurrency — defaults to unbounded`);
    }
  }

  // Layer 10: While loop safety (maxIterations)
  for (const step of flattenSteps(workflow.steps)) {
    if (step.type === "while" && step.maxIterations > 50) {
      warnings.push(`While step "${step.id}" has maxIterations=${step.maxIterations} — risk of long execution`);
    }
  }

  // Layer 11: Cron schedule validation
  if (workflow.trigger.type === "cron") {
    const parts = workflow.trigger.schedule.split(" ");
    if (parts.length < 5 || parts.length > 6) {
      errors.push({ layer: "cron", path: "trigger.schedule", message: "Cron schedule must have 5-6 fields" });
    }
  }

  // Layer 12: Output variable collisions
  const outputNames = new Map<string, string>();
  for (const step of flattenSteps(workflow.steps)) {
    if (step.outputAs) {
      const existing = outputNames.get(step.outputAs);
      if (existing) {
        errors.push({
          layer: "output-collision",
          path: step.id,
          message: `Output "${step.outputAs}" already defined by step "${existing}"`,
        });
      }
      outputNames.set(step.outputAs, step.id);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Helpers ──────────────────────────────────────────────────────

function collectStepIds(steps: Step[]): string[] {
  const ids: string[] = [];
  for (const step of steps) {
    ids.push(step.id);
    if (step.type === "parallel") ids.push(...collectStepIds(step.steps));
    if (step.type === "forEach") ids.push(...collectStepIds(step.steps));
    if (step.type === "while") ids.push(...collectStepIds(step.steps));
    if (step.type === "condition") {
      ids.push(...collectStepIds(step.onTrue));
      if (step.onFalse) ids.push(...collectStepIds(step.onFalse));
    }
  }
  return ids;
}

function flattenSteps(steps: Step[]): Step[] {
  const flat: Step[] = [];
  for (const step of steps) {
    flat.push(step);
    if (step.type === "parallel") flat.push(...flattenSteps(step.steps));
    if (step.type === "forEach") flat.push(...flattenSteps(step.steps));
    if (step.type === "while") flat.push(...flattenSteps(step.steps));
    if (step.type === "condition") {
      flat.push(...flattenSteps(step.onTrue));
      if (step.onFalse) flat.push(...flattenSteps(step.onFalse));
    }
  }
  return flat;
}

function detectCycles(steps: Step[]): string | null {
  const graph = new Map<string, string[]>();
  for (const step of flattenSteps(steps)) {
    graph.set(step.id, step.dependsOn ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): string | null {
    if (inStack.has(node)) return node;
    if (visited.has(node)) return null;
    visited.add(node);
    inStack.add(node);
    for (const dep of graph.get(node) ?? []) {
      const cycle = dfs(dep);
      if (cycle) return `${node} → ${cycle}`;
    }
    inStack.delete(node);
    return null;
  }

  for (const id of graph.keys()) {
    const cycle = dfs(id);
    if (cycle) return cycle;
  }
  return null;
}

function collectVariableRefs(steps: Step[]): Array<{ ref: string; stepId: string }> {
  const refs: Array<{ ref: string; stepId: string }> = [];
  const varPattern = /\{\{([^}]+)\}\}/g;

  function extract(text: string, stepId: string) {
    let match;
    while ((match = varPattern.exec(text)) !== null) {
      refs.push({ ref: match[1].trim(), stepId });
    }
  }

  for (const step of flattenSteps(steps)) {
    if (step.type === "agent-delegate") extract(step.prompt, step.id);
    if (step.type === "condition") extract(step.condition, step.id);
    if (step.type === "forEach") extract(step.collection, step.id);
    if (step.type === "while") extract(step.condition, step.id);
    if (step.type === "action" && step.params) {
      for (const val of Object.values(step.params)) {
        if (typeof val === "string") extract(val, step.id);
      }
    }
  }
  return refs;
}

function measureParallelDepth(steps: Step[], depth = 0): number {
  let max = depth;
  for (const step of steps) {
    if (step.type === "parallel") {
      max = Math.max(max, measureParallelDepth(step.steps, depth + 1));
    }
    if (step.type === "forEach") {
      max = Math.max(max, measureParallelDepth(step.steps, depth));
    }
    if (step.type === "condition") {
      max = Math.max(max, measureParallelDepth(step.onTrue, depth));
      if (step.onFalse) max = Math.max(max, measureParallelDepth(step.onFalse, depth));
    }
  }
  return max;
}
