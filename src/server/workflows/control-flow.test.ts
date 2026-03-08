import { describe, it, expect, vi } from "vitest";
import type { StepExecutor, WorkflowContext, StepResult } from "./control-flow";
import {
  executeCondition,
  executeForEach,
  executeWhile,
  executeParallel,
} from "./control-flow";
import type {
  ConditionStep,
  ForEachStep,
  WhileStep,
  ParallelStep,
  ActionStep,
} from "./workflow-schema";

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    organizationId: "org_1",
    workflowName: "test",
    runId: "run_1",
    variables: {},
    config: {},
    input: {},
    aborted: false,
    ...overrides,
  };
}

function makeExecutor(output: unknown = "ok"): StepExecutor {
  return vi.fn(async (step): Promise<StepResult> => ({
    stepId: step.id,
    status: "success",
    output,
    durationMs: 1,
  }));
}

describe("executeCondition", () => {
  it("branches on true condition", async () => {
    const step: ConditionStep = {
      id: "cond1",
      type: "condition",
      condition: "true",
      onTrue: [{ id: "t1", type: "action", action: "a.b" } as ActionStep],
      onFalse: [{ id: "f1", type: "action", action: "c.d" } as ActionStep],
    };
    const executor = makeExecutor();
    const ctx = makeContext();

    const results = await executeCondition(step, ctx, executor);

    // First result is the condition step itself
    expect(results[0].stepId).toBe("cond1");
    expect((results[0].output as any).conditionMet).toBe(true);
    // Executor called with onTrue branch
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1" }),
      expect.anything(),
    );
    expect(executor).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "f1" }),
      expect.anything(),
    );
  });

  it("branches on false condition", async () => {
    const step: ConditionStep = {
      id: "cond1",
      type: "condition",
      condition: "false",
      onTrue: [{ id: "t1", type: "action", action: "a.b" } as ActionStep],
      onFalse: [{ id: "f1", type: "action", action: "c.d" } as ActionStep],
    };
    const executor = makeExecutor();
    const ctx = makeContext();

    const results = await executeCondition(step, ctx, executor);

    expect((results[0].output as any).conditionMet).toBe(false);
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "f1" }),
      expect.anything(),
    );
  });

  it("respects context.aborted", async () => {
    const step: ConditionStep = {
      id: "cond1",
      type: "condition",
      condition: "true",
      onTrue: [
        { id: "t1", type: "action", action: "a.b" } as ActionStep,
        { id: "t2", type: "action", action: "a.b" } as ActionStep,
      ],
    };
    const ctx = makeContext({ aborted: true });
    const executor = makeExecutor();

    await executeCondition(step, ctx, executor);
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("executeForEach", () => {
  it("batches by maxConcurrency", async () => {
    const step: ForEachStep = {
      id: "fe1",
      type: "forEach",
      collection: "items",
      as: "item",
      maxConcurrency: 2,
      steps: [{ id: "s1", type: "action", action: "a.b" } as ActionStep],
    };
    const ctx = makeContext({
      variables: { items: [1, 2, 3, 4, 5] },
    });
    const executor = makeExecutor();

    const results = await executeForEach(step, ctx, executor);

    // 5 items processed + 1 forEach summary = 6 results
    expect(results).toHaveLength(6);
    expect(executor).toHaveBeenCalledTimes(5);
  });

  it("respects context.aborted", async () => {
    const step: ForEachStep = {
      id: "fe1",
      type: "forEach",
      collection: "items",
      as: "item",
      maxConcurrency: 1,
      steps: [{ id: "s1", type: "action", action: "a.b" } as ActionStep],
    };
    const ctx = makeContext({
      variables: { items: [1, 2, 3] },
      aborted: true,
    });
    const executor = makeExecutor();

    await executeForEach(step, ctx, executor);
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("executeWhile", () => {
  it("respects maxIterations safety", async () => {
    const step: WhileStep = {
      id: "w1",
      type: "while",
      condition: "true",
      maxIterations: 3,
      steps: [{ id: "s1", type: "action", action: "a.b" } as ActionStep],
    };
    const ctx = makeContext({ variables: {} });
    const executor = makeExecutor();

    const results = await executeWhile(step, ctx, executor);

    // 3 iterations + 1 summary
    expect(results).toHaveLength(4);
    expect(executor).toHaveBeenCalledTimes(3);
    expect((results[0].output as any).maxReached).toBe(true);
  });

  it("stops when condition becomes false", async () => {
    let callCount = 0;
    const step: WhileStep = {
      id: "w1",
      type: "while",
      condition: "{{running}}",
      maxIterations: 100,
      steps: [{ id: "s1", type: "action", action: "a.b" } as ActionStep],
    };
    const ctx = makeContext({ variables: { running: "true" } });

    const executor: StepExecutor = vi.fn(async (s): Promise<StepResult> => {
      callCount++;
      if (callCount >= 2) ctx.variables.running = "false";
      return { stepId: s.id, status: "success", output: null, durationMs: 1 };
    });

    const results = await executeWhile(step, ctx, executor);
    // Should have stopped after 2 iterations
    expect(callCount).toBe(2);
    expect((results[0].output as any).maxReached).toBe(false);
  });

  it("respects context.aborted", async () => {
    const step: WhileStep = {
      id: "w1",
      type: "while",
      condition: "true",
      maxIterations: 10,
      steps: [{ id: "s1", type: "action", action: "a.b" } as ActionStep],
    };
    const ctx = makeContext({ aborted: true });
    const executor = makeExecutor();

    await executeWhile(step, ctx, executor);
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("executeParallel", () => {
  it("runs all children concurrently", async () => {
    const step: ParallelStep = {
      id: "p1",
      type: "parallel",
      steps: [
        { id: "c1", type: "action", action: "a.b" } as ActionStep,
        { id: "c2", type: "action", action: "c.d" } as ActionStep,
        { id: "c3", type: "action", action: "e.f" } as ActionStep,
      ],
    };
    const executor = makeExecutor();
    const ctx = makeContext();

    const results = await executeParallel(step, ctx, executor);

    // 3 children + 1 parallel summary
    expect(results).toHaveLength(4);
    expect(executor).toHaveBeenCalledTimes(3);
    expect(results[0].stepId).toBe("p1");
    expect((results[0].output as any).parallelCount).toBe(3);
  });

  it("captures errors from failed children", async () => {
    const step: ParallelStep = {
      id: "p1",
      type: "parallel",
      steps: [
        { id: "c1", type: "action", action: "a.b" } as ActionStep,
        { id: "c2", type: "action", action: "c.d" } as ActionStep,
      ],
    };
    const executor: StepExecutor = vi.fn(async (s): Promise<StepResult> => {
      if (s.id === "c2") throw new Error("boom");
      return { stepId: s.id, status: "success", output: "ok", durationMs: 1 };
    });
    const ctx = makeContext();

    const results = await executeParallel(step, ctx, executor);

    const errorResult = results.find((r) => r.stepId === "c2");
    expect(errorResult?.status).toBe("error");
    expect(errorResult?.error).toContain("boom");
    // Summary should reflect error
    expect(results[0].status).toBe("error");
  });
});
