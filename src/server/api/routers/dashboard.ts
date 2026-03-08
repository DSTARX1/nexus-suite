import { createTRPCRouter, onboardedProcedure } from "../trpc";
import { getSpendSummary } from "@/server/services/llm-budget";

export const dashboardRouter = createTRPCRouter({
  getWorkflowStats: onboardedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.postRecord.groupBy({
      by: ["status"],
      where: { organizationId: ctx.organizationId },
      _count: true,
    });

    const counts = { active: 0, completed: 0, failed: 0, queued: 0 };
    for (const g of groups) {
      if (g.status === "POSTING") counts.active = g._count;
      else if (g.status === "SUCCESS") counts.completed = g._count;
      else if (g.status === "FAILED") counts.failed = g._count;
      else if (g.status === "SCHEDULED") counts.queued = g._count;
    }
    return counts;
  }),

  // LLM spend bar — real data from Redis + DB
  getSpendSummary: onboardedProcedure.query(async ({ ctx }) => {
    return getSpendSummary(ctx.organizationId);
  }),

  // Recent posts timeline — real data with joins
  getRecentPosts: onboardedProcedure.query(async ({ ctx }) => {
    const records = await ctx.db.postRecord.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        variation: { select: { caption: true } },
        account: { select: { accountLabel: true } },
      },
    });

    return records.map((r) => ({
      id: r.id,
      platform: `${r.account.accountLabel} · ${r.platform}`,
      title: r.variation.caption ?? r.caption ?? "(untitled)",
      status: r.status,
      publishedAt: r.postedAt ?? r.scheduledAt,
    }));
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
