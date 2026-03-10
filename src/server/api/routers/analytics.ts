import { z } from "zod";
import { createTRPCRouter, onboardedProcedure } from "../trpc";

// ── Helpers ─────────────────────────────────────────────────────

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parsePeriodDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : 30;
}

const periodInput = z
  .object({
    period: z.string().regex(/^\d+d$/).default("30d"),
    platform: z.enum(["YOUTUBE", "TIKTOK", "INSTAGRAM", "LINKEDIN", "X", "FACEBOOK"]).optional(),
  })
  .optional();

// ── Router ──────────────────────────────────────────────────────

export const analyticsRouter = createTRPCRouter({
  /**
   * Summary cards: total posts, success rate, total views/likes from tracked posts,
   * and average engagement across the org's own posts.
   */
  getSummary: onboardedProcedure.input(periodInput).query(async ({ ctx, input }) => {
    const days = parsePeriodDays(input?.period ?? "30d");
    const since = daysAgo(days);
    const platformFilter = input?.platform;

    // Own posts stats
    const where: Record<string, unknown> = {
      organizationId: ctx.organizationId,
      createdAt: { gte: since },
    };
    if (platformFilter) where.platform = platformFilter;

    const postGroups = await ctx.db.postRecord.groupBy({
      by: ["status"],
      where,
      _count: true,
    });

    let totalPosts = 0;
    let successPosts = 0;
    let failedPosts = 0;
    for (const g of postGroups) {
      totalPosts += g._count;
      if (g.status === "SUCCESS") successPosts = g._count;
      if (g.status === "FAILED") failedPosts = g._count;
    }

    // Competitor tracked posts — aggregate views/likes/comments
    const trackedAgg = await ctx.db.trackedPost.aggregate({
      where: {
        creator: { organizationId: ctx.organizationId },
        createdAt: { gte: since },
        ...(platformFilter ? { creator: { organizationId: ctx.organizationId, platform: platformFilter } } : {}),
      },
      _sum: { views: true, likes: true, comments: true },
      _count: true,
      _avg: { views: true, likes: true },
    });

    const outlierCount = await ctx.db.trackedPost.count({
      where: {
        creator: { organizationId: ctx.organizationId },
        createdAt: { gte: since },
        isOutlier: true,
      },
    });

    return {
      period: `${days}d`,
      totalPosts,
      successPosts,
      failedPosts,
      successRate: totalPosts > 0 ? Math.round((successPosts / totalPosts) * 100) : 0,
      trackedPostCount: trackedAgg._count,
      totalViews: trackedAgg._sum.views ?? 0,
      totalLikes: trackedAgg._sum.likes ?? 0,
      totalComments: trackedAgg._sum.comments ?? 0,
      avgViews: Math.round(trackedAgg._avg.views ?? 0),
      avgLikes: Math.round(trackedAgg._avg.likes ?? 0),
      outlierCount,
    };
  }),

  /**
   * Engagement over time — daily aggregation of tracked post metrics for charting.
   */
  getEngagementOverTime: onboardedProcedure.input(periodInput).query(async ({ ctx, input }) => {
    const days = parsePeriodDays(input?.period ?? "30d");
    const since = daysAgo(days);

    // Use PostSnapshot data grouped by date
    const snapshots = await ctx.db.postSnapshot.findMany({
      where: {
        capturedAt: { gte: since },
        post: { creator: { organizationId: ctx.organizationId } },
      },
      select: {
        capturedAt: true,
        views: true,
        likes: true,
        comments: true,
      },
      orderBy: { capturedAt: "asc" },
    });

    // Bucket by date
    const buckets = new Map<string, { views: number; likes: number; comments: number; count: number }>();
    for (const s of snapshots) {
      const key = s.capturedAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key) ?? { views: 0, likes: 0, comments: 0, count: 0 };
      bucket.views += s.views;
      bucket.likes += s.likes;
      bucket.comments += s.comments;
      bucket.count += 1;
      buckets.set(key, bucket);
    }

    return Array.from(buckets.entries()).map(([date, data]) => ({
      date,
      views: data.views,
      likes: data.likes,
      comments: data.comments,
      snapshots: data.count,
    }));
  }),

  /**
   * Top performing tracked posts — sorted by views, flagged outliers first.
   */
  getTopContent: onboardedProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(50).default(10),
          period: z.string().regex(/^\d+d$/).default("30d"),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const days = parsePeriodDays(input?.period ?? "30d");
      const since = daysAgo(days);
      const limit = input?.limit ?? 10;

      const posts = await ctx.db.trackedPost.findMany({
        where: {
          creator: { organizationId: ctx.organizationId },
          createdAt: { gte: since },
        },
        orderBy: [{ isOutlier: "desc" }, { views: "desc" }],
        take: limit,
        include: {
          creator: { select: { username: true, platform: true } },
        },
      });

      return posts.map((p) => ({
        id: p.id,
        title: p.title ?? "(untitled)",
        url: p.url,
        platform: p.creator.platform,
        creator: p.creator.username,
        views: p.views,
        likes: p.likes,
        comments: p.comments,
        isOutlier: p.isOutlier,
        outlierScore: p.outlierScore,
        publishedAt: p.publishedAt,
      }));
    }),

  /**
   * Competitor comparison — aggregate metrics per tracked creator.
   */
  getCompetitorComparison: onboardedProcedure.input(periodInput).query(async ({ ctx, input }) => {
    const days = parsePeriodDays(input?.period ?? "30d");
    const since = daysAgo(days);

    const creators = await ctx.db.trackedCreator.findMany({
      where: {
        organizationId: ctx.organizationId,
        isActive: true,
      },
      select: {
        id: true,
        username: true,
        platform: true,
        followerCount: true,
        posts: {
          where: { createdAt: { gte: since } },
          select: { views: true, likes: true, comments: true, isOutlier: true },
        },
      },
      orderBy: { followerCount: "desc" },
    });

    return creators.map((c) => {
      const postCount = c.posts.length;
      const totalViews = c.posts.reduce((sum, p) => sum + p.views, 0);
      const totalLikes = c.posts.reduce((sum, p) => sum + p.likes, 0);
      const totalComments = c.posts.reduce((sum, p) => sum + p.comments, 0);
      const outliers = c.posts.filter((p) => p.isOutlier).length;

      return {
        id: c.id,
        username: c.username,
        platform: c.platform,
        followerCount: c.followerCount,
        postCount,
        totalViews,
        totalLikes,
        totalComments,
        avgViews: postCount > 0 ? Math.round(totalViews / postCount) : 0,
        avgLikes: postCount > 0 ? Math.round(totalLikes / postCount) : 0,
        outliers,
      };
    });
  }),

  /**
   * Platform breakdown — own post stats grouped by platform.
   */
  getPlatformBreakdown: onboardedProcedure.input(periodInput).query(async ({ ctx, input }) => {
    const days = parsePeriodDays(input?.period ?? "30d");
    const since = daysAgo(days);

    const groups = await ctx.db.postRecord.groupBy({
      by: ["platform", "status"],
      where: {
        organizationId: ctx.organizationId,
        createdAt: { gte: since },
      },
      _count: true,
    });

    // Aggregate by platform
    const platformMap = new Map<
      string,
      { total: number; success: number; failed: number; scheduled: number }
    >();

    for (const g of groups) {
      const entry = platformMap.get(g.platform) ?? {
        total: 0,
        success: 0,
        failed: 0,
        scheduled: 0,
      };
      entry.total += g._count;
      if (g.status === "SUCCESS") entry.success += g._count;
      if (g.status === "FAILED") entry.failed += g._count;
      if (g.status === "SCHEDULED") entry.scheduled += g._count;
      platformMap.set(g.platform, entry);
    }

    return Array.from(platformMap.entries()).map(([platform, stats]) => ({
      platform,
      ...stats,
      successRate: stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0,
    }));
  }),

  /**
   * Recent own posts with details — for the "Recent Posts" table on analytics page.
   */
  getRecentPosts: onboardedProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(50).default(20),
          cursor: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 20;

      const records = await ctx.db.postRecord.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        cursor: input?.cursor ? { id: input.cursor } : undefined,
        include: {
          variation: { select: { caption: true } },
          account: { select: { accountLabel: true, platform: true } },
        },
      });

      let nextCursor: string | undefined;
      if (records.length > limit) {
        const next = records.pop();
        nextCursor = next?.id;
      }

      return {
        posts: records.map((r) => ({
          id: r.id,
          platform: r.platform,
          account: r.account.accountLabel,
          title: r.variation.caption ?? r.caption ?? "(untitled)",
          status: r.status,
          scheduledAt: r.scheduledAt,
          postedAt: r.postedAt,
          externalPostId: r.externalPostId,
        })),
        nextCursor,
      };
    }),
});
