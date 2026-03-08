import { createTRPCRouter, onboardedProcedure } from "../trpc";
import { getSpendSummary } from "@/server/services/llm-budget";

export const dashboardRouter = createTRPCRouter({
  // Active workflows — stub until Workflow model exists
  getWorkflowStats: onboardedProcedure.query(async () => {
    return { active: 0, completed: 0, failed: 0, queued: 0 };
  }),

  // LLM spend bar — real data from Redis + DB
  getSpendSummary: onboardedProcedure.query(async ({ ctx }) => {
    return getSpendSummary(ctx.organizationId);
  }),

  // Recent posts timeline — stub until Post model exists
  getRecentPosts: onboardedProcedure.query(async () => {
    return [] as {
      id: string;
      platform: string;
      title: string;
      status: string;
      publishedAt: Date | null;
    }[];
  }),

  // Account health grid — real data from OrgPlatformToken
  getAccountHealth: onboardedProcedure.query(async ({ ctx }) => {
    const tokens = await ctx.db.orgPlatformToken.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        platform: true,
        accountLabel: true,
        accountType: true,
        healthScore: true,
        consecutiveFailures: true,
        circuitState: true,
        lastFailureAt: true,
        lastSuccessAt: true,
      },
      orderBy: { platform: "asc" },
    });

    return tokens;
  }),
});
