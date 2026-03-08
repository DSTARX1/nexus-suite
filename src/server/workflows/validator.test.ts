import { describe, it, expect } from "vitest";
import { validateWorkflow } from "./validator";
import type { WorkflowDefinition } from "./workflow-schema";

// Helper: minimal valid workflow object
function validWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: "test-workflow",
    organizationId: "org_1",
    trigger: { type: "manual" },
    steps: [
      { id: "step1", type: "action", action: "service.method" },
    ],
    ...overrides,
  } as WorkflowDefinition;
}

describe("validateWorkflow", () => {
  // ── Layer 1: YAML parsing ──────────────────────────────────────
  describe("Layer 1: YAML parse", () => {
    it("valid YAML string passes", () => {
      const yaml = `
name: test
organizationId: org_1
trigger:
  type: manual
steps:
  - id: s1
    type: action
    action: svc.method
`;
      const result = validateWorkflow(yaml);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("invalid YAML fails", () => {
      const result = validateWorkflow("{ invalid: yaml: [[[");
      expect(result.valid).toBe(false);
      expect(result.errors[0].layer).toBe("yaml-parse");
    });
  });

  // ── Layer 2: Zod schema ────────────────────────────────────────
  describe("Layer 2: schema", () => {
    it("bad schema fails", () => {
      const result = validateWorkflow({ name: 123 } as any);
      expect(result.valid).toBe(false);
      expect(result.errors[0].layer).toBe("schema");
    });

    it("valid object passes schema", () => {
      const result = validateWorkflow(validWorkflow());
      expect(result.valid).toBe(true);
    });
  });

  // ── Layer 3: Step ID uniqueness ────────────────────────────────
  describe("Layer 3: uniqueness", () => {
    it("duplicate step IDs produce error", () => {
      const wf = validWorkflow({
        steps: [
          { id: "dup", type: "action", action: "a.b" },
          { id: "dup", type: "action", action: "c.d" },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.layer === "uniqueness")).toBe(true);
    });
  });

  // ── Layer 4: Missing dependency refs ───────────────────────────
  describe("Layer 4: dependency refs", () => {
    it("missing dependency ref produces error", () => {
      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "action", action: "a.b", dependsOn: ["nonexistent"] },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.layer === "dependency")).toBe(true);
    });

    it("valid dependency ref passes", () => {
      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "action", action: "a.b" },
          { id: "s2", type: "action", action: "c.d", dependsOn: ["s1"] },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(true);
    });
  });

  // ── Layer 5: Circular dependencies ─────────────────────────────
  describe("Layer 5: circular deps", () => {
    it("circular deps produce error", () => {
      const wf = validWorkflow({
        steps: [
          { id: "a", type: "action", action: "x.y", dependsOn: ["b"] },
          { id: "b", type: "action", action: "x.y", dependsOn: ["a"] },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.layer === "cycle")).toBe(true);
    });
  });

  // ── Layer 6: Variable refs ─────────────────────────────────────
  describe("Layer 6: variable refs", () => {
    it("unknown variable ref produces warning", () => {
      const wf = validWorkflow({
        steps: [
          {
            id: "s1",
            type: "action",
            action: "a.b",
            params: { url: "{{unknownVar}}" },
          },
        ] as any,
      });
      const result = validateWorkflow(wf);
      // Unknown refs are warnings, not errors
      expect(result.warnings.some((w) => w.includes("unknownVar"))).toBe(true);
    });

    it("config and input refs do not warn", () => {
      const wf = validWorkflow({
        config: { threshold: 5 },
        input: { sourceUrl: "string" },
        steps: [
          {
            id: "s1",
            type: "action",
            action: "a.b",
            params: { t: "{{config.threshold}}", u: "{{input.sourceUrl}}" },
          },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.warnings.filter((w) => w.includes("config") || w.includes("input"))).toHaveLength(0);
    });
  });

  // ── Layer 7: Agent-delegate prompt ─────────────────────────────
  describe("Layer 7: agent-delegate prompt", () => {
    it("empty prompt produces error", () => {
      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "agent-delegate", agent: "writer", prompt: "" },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.layer === "agent")).toBe(true);
    });

    it("whitespace-only prompt produces error", () => {
      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "agent-delegate", agent: "writer", prompt: "   " },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.layer === "agent")).toBe(true);
    });

    it("valid prompt passes", () => {
      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "agent-delegate", agent: "writer", prompt: "Write a post" },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(true);
    });
  });

  // ── Layer 8: Parallel nesting depth ────────────────────────────
  describe("Layer 8: parallel nesting", () => {
    it("deep parallel nesting produces warning", () => {
      // 4 levels deep
      const wf = validWorkflow({
        steps: [
          {
            id: "p1", type: "parallel", steps: [
              {
                id: "p2", type: "parallel", steps: [
                  {
                    id: "p3", type: "parallel", steps: [
                      {
                        id: "p4", type: "parallel", steps: [
                          { id: "s1", type: "action", action: "a.b" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.warnings.some((w) => w.includes("nesting depth"))).toBe(true);
    });
  });

  // ── Layer 9: forEach without maxConcurrency ────────────────────
  describe("Layer 9: forEach maxConcurrency", () => {
    it("forEach without maxConcurrency produces warning", () => {
      const wf = validWorkflow({
        steps: [
          {
            id: "fe1",
            type: "forEach",
            collection: "{{items}}",
            as: "item",
            steps: [{ id: "s1", type: "action", action: "a.b" }],
          },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.warnings.some((w) => w.includes("maxConcurrency"))).toBe(true);
    });

    it("forEach with maxConcurrency does not warn", () => {
      const wf = validWorkflow({
        steps: [
          {
            id: "fe1",
            type: "forEach",
            collection: "{{items}}",
            as: "item",
            maxConcurrency: 3,
            steps: [{ id: "s1", type: "action", action: "a.b" }],
          },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.warnings.filter((w) => w.includes("maxConcurrency"))).toHaveLength(0);
    });
  });

  // ── Layer 10: While maxIterations > 50 ─────────────────────────
  describe("Layer 10: while maxIterations", () => {
    it("maxIterations > 50 produces warning", () => {
      const wf = validWorkflow({
        steps: [
          {
            id: "w1",
            type: "while",
            condition: "true",
            maxIterations: 100,
            steps: [{ id: "s1", type: "action", action: "a.b" }],
          },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.warnings.some((w) => w.includes("maxIterations=100"))).toBe(true);
    });
  });

  // ── Layer 11: Invalid cron ─────────────────────────────────────
  describe("Layer 11: cron schedule", () => {
    it("invalid cron schedule produces error", () => {
      const wf = validWorkflow({
        trigger: { type: "cron", schedule: "bad cron" },
      });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.layer === "cron")).toBe(true);
    });

    it("valid 5-field cron passes", () => {
      const wf = validWorkflow({
        trigger: { type: "cron", schedule: "0 9 * * 1-5" },
      });
      const result = validateWorkflow(wf);
      expect(result.errors.filter((e) => e.layer === "cron")).toHaveLength(0);
    });
  });

  // ── Layer 12: Output name collisions ───────────────────────────
  describe("Layer 12: output collisions", () => {
    it("duplicate outputAs produces error", () => {
      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "action", action: "a.b", outputAs: "result" },
          { id: "s2", type: "action", action: "c.d", outputAs: "result" },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.layer === "output-collision")).toBe(true);
    });

    it("unique outputAs passes", () => {
      const wf = validWorkflow({
        steps: [
          { id: "s1", type: "action", action: "a.b", outputAs: "resultA" },
          { id: "s2", type: "action", action: "c.d", outputAs: "resultB" },
        ] as any,
      });
      const result = validateWorkflow(wf);
      expect(result.errors.filter((e) => e.layer === "output-collision")).toHaveLength(0);
    });
  });
});
