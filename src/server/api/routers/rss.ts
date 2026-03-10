import { z } from "zod";
import { createTRPCRouter, subscribedProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";

export const rssRouter = createTRPCRouter({
  listFeeds: subscribedProcedure
    .input(
      z
        .object({
          cursor: z.string().optional(),
          limit: z.number().min(1).max(100).default(25),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const { cursor, limit = 25 } = input ?? {};

      const feeds = await ctx.db.rssFeed.findMany({
        where: { organizationId: ctx.organizationId },
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { articles: true } },
        },
      });

      let nextCursor: string | undefined;
      if (feeds.length > limit) {
        const next = feeds.pop();
        nextCursor = next?.id;
      }

      return { feeds, nextCursor };
    }),

  addFeed: subscribedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        url: z.string().url(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Check for duplicate URL within org
      const existing = await ctx.db.rssFeed.findUnique({
        where: {
          organizationId_url: {
            organizationId: ctx.organizationId,
            url: input.url,
          },
        },
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This feed URL is already added.",
        });
      }

      return ctx.db.rssFeed.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          url: input.url,
        },
      });
    }),

  deleteFeed: subscribedProcedure
    .input(z.object({ feedId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const feed = await ctx.db.rssFeed.findFirst({
        where: { id: input.feedId, organizationId: ctx.organizationId },
      });

      if (!feed) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Feed not found" });
      }

      await ctx.db.rssFeed.delete({ where: { id: input.feedId } });

      return { deleted: true };
    }),

  toggleActive: subscribedProcedure
    .input(z.object({ feedId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const feed = await ctx.db.rssFeed.findFirst({
        where: { id: input.feedId, organizationId: ctx.organizationId },
      });

      if (!feed) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Feed not found" });
      }

      return ctx.db.rssFeed.update({
        where: { id: input.feedId },
        data: { isActive: !feed.isActive },
      });
    }),

  listArticles: subscribedProcedure
    .input(
      z.object({
        feedId: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {
        organizationId: ctx.organizationId,
      };
      if (input.feedId) where.feedId = input.feedId;

      const articles = await ctx.db.rssArticle.findMany({
        where,
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        orderBy: { publishedAt: "desc" },
        include: { feed: { select: { name: true } } },
      });

      let nextCursor: string | undefined;
      if (articles.length > input.limit) {
        const next = articles.pop();
        nextCursor = next?.id;
      }

      return { articles, nextCursor };
    }),
});
