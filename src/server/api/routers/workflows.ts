import { z } from "zod";
import { createTRPCRouter, onboardedProcedure, tierGatedProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import PgBoss from "pg-boss";

// ── pg-boss singleton ────────────────────────────────────────

const WORKFLOW_QUEUE = "workflow:run";

let boss: PgBoss | null = null;

async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss(process.env.DATABASE_URL!);
    await boss.start();
  }
  return boss;
}

// ── Helpers ─────────────────────────────────────────────────────

const AGENTS_DIR = join(process.cwd(), "src", "agents", "clients");

interface WorkflowDef {
  name: string;
  description: string;
  trigger: { type: string; schedule?: string };
}

function loadOrgWorkflows(orgId: string): WorkflowDef[] {
  const workflowDir = join(AGENTS_DIR, orgId, "workflows");
  if (!existsSync(workflowDir)) return [];

  const files = readdirSync(workflowDir).filter((f) => f.endsWith(".yaml"));
  return files.map((file) => {
    const raw = readFileSync(join(workflowDir, file), "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    return {
      name: (parsed.name as string) ?? file.replace(".yaml", ""),
      description: (parsed.description as string) ?? "",
      trigger: (parsed.trigger as WorkflowDef["trigger"]) ?? { type: "manual" },
    };
  });
}

// ── Router ──────────────────────────────────────────────────────

export const workflowsRouter = createTRPCRouter({
  list: onboardedProcedure.query(({ ctx }) => {
    return loadOrgWorkflows(ctx.organizationId);
  }),

  runHistory: onboardedProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(25),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const { cursor, limit = 25 } = input ?? {};

      const records = await ctx.db.postRecord.findMany({
        where: { organizationId: ctx.organizationId },
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          platform: true,
          status: true,
          scheduledAt: true,
          postedAt: true,
          createdAt: true,
        },
      });

      let nextCursor: string | undefined;
      if (records.length > limit) {
        const next = records.pop();
        nextCursor = next?.id;
      }

      return { records, nextCursor };
    }),

  runNow: tierGatedProcedure("maxWorkflowRuns")
    .input(z.object({ workflowName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const workflows = loadOrgWorkflows(ctx.organizationId);
      const match = workflows.find((w) => w.name === input.workflowName);

      if (!match) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workflow "${input.workflowName}" not found`,
        });
      }

      const b = await getBoss();
      await b.send(WORKFLOW_QUEUE, {
        workflowName: input.workflowName,
        organizationId: ctx.organizationId,
        triggeredAt: new Date().toISOString(),
      });

      return { queued: true, workflowName: input.workflowName };
    }),
});
