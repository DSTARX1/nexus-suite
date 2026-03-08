import { z } from "zod";

// ── Step Types ───────────────────────────────────────────────────

const baseStep = z.object({
  id: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  outputAs: z.string().optional(),
  retries: z.number().int().min(0).max(5).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const actionStep = baseStep.extend({
  type: z.literal("action"),
  action: z.string(), // "service.method" format
  params: z.record(z.unknown()).optional(),
});

export const agentDelegateStep = baseStep.extend({
  type: z.literal("agent-delegate"),
  agent: z.string(),
  prompt: z.string(),
  model: z.string().optional(), // override default model
  maxTokens: z.number().int().positive().optional(),
});

export const conditionStep = baseStep.extend({
  type: z.literal("condition"),
  condition: z.string(), // expression like "{{score}} >= 7"
  onTrue: z.array(z.lazy(() => stepSchema)).min(1),
  onFalse: z.array(z.lazy(() => stepSchema)).optional(),
});

export const forEachStep = baseStep.extend({
  type: z.literal("forEach"),
  collection: z.string(), // "{{items}}" reference
  as: z.string(),
  steps: z.array(z.lazy(() => stepSchema)).min(1),
  maxConcurrency: z.number().int().positive().optional(),
});

export const whileStep = baseStep.extend({
  type: z.literal("while"),
  condition: z.string(),
  maxIterations: z.number().int().positive().default(10),
  steps: z.array(z.lazy(() => stepSchema)).min(1),
});

export const parallelStep = baseStep.extend({
  type: z.literal("parallel"),
  steps: z.array(z.lazy(() => stepSchema)).min(1),
});

export const stepSchema: z.ZodType<any> = z.discriminatedUnion("type", [
  actionStep,
  agentDelegateStep,
  conditionStep,
  forEachStep,
  whileStep,
  parallelStep,
]);

export type Step = z.infer<typeof stepSchema>;
export type ActionStep = z.infer<typeof actionStep>;
export type AgentDelegateStep = z.infer<typeof agentDelegateStep>;
export type ConditionStep = z.infer<typeof conditionStep>;
export type ForEachStep = z.infer<typeof forEachStep>;
export type WhileStep = z.infer<typeof whileStep>;
export type ParallelStep = z.infer<typeof parallelStep>;

// ── Trigger Types ────────────────────────────────────────────────

const cronTrigger = z.object({
  type: z.literal("cron"),
  schedule: z.string(), // cron expression
});

const manualTrigger = z.object({
  type: z.literal("manual"),
});

const eventTrigger = z.object({
  type: z.literal("event"),
  event: z.string(), // e.g. "outlier:detected"
  filter: z.record(z.unknown()).optional(),
});

const triggerSchema = z.discriminatedUnion("type", [
  cronTrigger,
  manualTrigger,
  eventTrigger,
]);

// ── Workflow Definition ──────────────────────────────────────────

export const workflowSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  organizationId: z.string(),
  trigger: triggerSchema,
  config: z.record(z.unknown()).optional(),
  input: z.record(z.string()).optional(), // input type declarations
  steps: z.array(stepSchema).min(1),
});

export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
