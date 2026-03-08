import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executeWorkflow,
  registerAction,
  type ActionHandler,
} from "./executor";
import type { WorkflowDefinition } from "./workflow-schema";

// Mock the agent-delegate and llm-budget modules
vi.mock("./agent-delegate", () => ({
  executeAgentDelegate: vi.fn(async () => ({ result: "agent-output" })),
}));

vi.mock("../services/llm-budget", () => ({
  checkLlmBudget: vi.fn(async () => ({
    allowed: true,
    spentCents: 0,
    budgetCents: 500,
    message: "OK",
  })),
}));

function validWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: "test-wf",
    organizationId: "org_1",
    trigger: { type: "manual" },
    steps: [
      { id: "s1", type: "action", action: "test.echo" },
    ],
    ...overrides,
  } as WorkflowDefinition;
}

describe("executor", () => {
  beforeEach(() => {
    // Register a simple echo action for tests
    registerAction("test.echo", async (params) => ({ echo: params }));
    registerAction("test.fail", async () => {
      throw new Error("intentional failure");
    });
  });

  describe("buildExecutionWaves (via executeWorkflow)", () => {
    it("groups independent steps into parallel waves", async () => {
      const wf = validWorkflow({
        steps: [
          { id: "a", type: "action", action: "test.echo" },
          { id: "b", type: "action", action: "test.echo" },
          { id: "c", type: "action", action: "test.echo", dependsOn: ["a", "b"] },
        ] as any,
      });
      const result = await executeWorkflow(wf);

      expect(result.status).toBe("completed");
      // a and b should run before c
      const stepOrder = result.steps.map((s) => s.stepId);
      const aIdx = stepOrder.indexOf("a");
      const bIdx = stepOrder.indexOf("b");
      const cIdx = stepOrder.indexOf("c");
      expect(cIdx).toBeGreaterThan(aIdx);
      expect(cIdx).toBeGreaterThan(bIdx);
    });

    it("deadlock detection throws", async () => {
      const wf = validWorkflow({
        steps: [
          { id: "a", type: "action", action: "test.echo", dependsOn: ["b"] },
          { id: "b", type: "action", action: "test.echo", dependsOn: ["a"] },
        ] as any,
      });
      // Circular deps are caught by validator, but let's verify
      // the workflow validation rejects it before wave building
      await expect(executeWorkflow(wf)).rejects.toThrow();
    });
  });

  describe("action execution", () => {
    it("completes successfully with registered action", async () => {
      const wf = validWorkflow({
        steps: [
          {
            id: "s1",
            type: "action",
            action: "test.echo",
            params: { msg: "hello" },
          },
        ] as any,
      });
      const result = await executeWorkflow(wf);

      expect(result.status).toBe("completed");
      expect(result.steps[0].status).toBe("success");
      expect(result.steps[0].output).toEqual({ echo: { msg: "hello" } });
    });

    it("reports error for unregistered action", async () => {
      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "action", action: "nonexistent.action" },
        ] as any,
      });
      const result = await executeWorkflow(wf);

      expect(result.status).toBe("failed");
      expect(result.steps[0].status).toBe("error");
      expect(result.steps[0].error).toContain("No action handler");
    });

    it("retries with backoff on failure", async () => {
      let attempts = 0;
      registerAction("test.flaky", async () => {
        attempts++;
        if (attempts < 3) throw new Error("flaky");
        return { ok: true };
      });

      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "action", action: "test.flaky", retries: 3 },
        ] as any,
      });
      const result = await executeWorkflow(wf);

      expect(result.status).toBe("completed");
      expect(attempts).toBe(3);
    }, 15000);
  });

  describe("agent-delegate", () => {
    it("checks LLM budget pre-flight", async () => {
      const { checkLlmBudget } = await import("../services/llm-budget.js");
      const mockCheck = vi.mocked(checkLlmBudget);
      mockCheck.mockResolvedValueOnce({
        allowed: false,
        spentCents: 500,
        budgetCents: 500,
        message: "Budget exceeded",
      } as any);

      const wf = validWorkflow({
        steps: [
          {
            id: "s1",
            type: "agent-delegate",
            agent: "writer",
            prompt: "Write something",
          },
        ] as any,
      });
      const result = await executeWorkflow(wf);

      expect(result.status).toBe("aborted");
      expect(result.steps.some((s) => s.error?.includes("LLM_BUDGET_EXCEEDED"))).toBe(true);
    });
  });

  describe("abort propagation", () => {
    it("stops remaining steps on abort", async () => {
      registerAction("test.abort", async (_params, context) => {
        context.aborted = true;
        context.abortReason = "test abort";
        return { aborted: true };
      });

      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "action", action: "test.abort" },
          { id: "s2", type: "action", action: "test.echo", dependsOn: ["s1"] },
        ] as any,
      });
      const result = await executeWorkflow(wf);

      expect(result.status).toBe("aborted");
      // s2 is in a later wave — when aborted, it gets skipped by the dispatcher
      // and may or may not appear in results depending on wave execution
      const s2 = result.steps.find((s) => s.stepId === "s2");
      if (s2) {
        expect(s2.status).toBe("skipped");
      } else {
        // s2 wave was never reached due to abort
        expect(result.steps.every((s) => s.stepId !== "s2")).toBe(true);
      }
    });
  });

  describe("variable passing", () => {
    it("stores outputAs and makes available to downstream steps", async () => {
      registerAction("test.produce", async () => ({ value: 42 }));
      registerAction("test.consume", async (params) => params);

      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "action", action: "test.produce", outputAs: "produced" },
          {
            id: "s2",
            type: "action",
            action: "test.consume",
            params: { data: "{{produced}}" },
            dependsOn: ["s1"],
          },
        ] as any,
      });
      const result = await executeWorkflow(wf);

      expect(result.status).toBe("completed");
      expect(result.variables.produced).toEqual({ value: 42 });
    });
  });
});
