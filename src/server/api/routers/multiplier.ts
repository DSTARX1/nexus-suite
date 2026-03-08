import { z } from "zod";
import { createTRPCRouter, onboardedProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";
import { Platform, Prisma } from "@prisma/client";
import { composeTransforms } from "../../../../services/media-engine/src/transforms.js";
import { sendMediaJob } from "@/server/services/media-queue";

async function assertMultiplierEnabled(ctx: { db: any; organizationId: string }) {
  const org = await ctx.db.organization.findUnique({
    where: { id: ctx.organizationId },
    select: { multiplierEnabled: true },
  });
  if (!org?.multiplierEnabled) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Multiplier feature not enabled for your tier",
    });
  }
}

export const multiplierRouter = createTRPCRouter({
  uploadSource: onboardedProcedure
    .input(
      z.object({
        url: z.string().url(),
        platform: z.nativeEnum(Platform),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertMultiplierEnabled(ctx);

      return ctx.db.sourceVideo.create({
        data: {
          organizationId: ctx.organizationId,
          url: input.url,
          platform: input.platform,
        },
      });
    }),

  generateVariations: onboardedProcedure
    .input(
      z.object({
        sourceVideoId: z.string(),
        count: z.number().int().min(1).max(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertMultiplierEnabled(ctx);

      const sourceVideo = await ctx.db.sourceVideo.findUnique({
        where: { id: input.sourceVideoId },
        select: { organizationId: true, url: true },
      });
      if (!sourceVideo || sourceVideo.organizationId !== ctx.organizationId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Source video not found" });
      }

      const variations = await ctx.db.$transaction(
        Array.from({ length: input.count }, (_, i) => {
          const transforms = composeTransforms();
          return ctx.db.videoVariation.create({
            data: {
              sourceVideoId: input.sourceVideoId,
              variationIndex: i,
              transforms: transforms as unknown as Prisma.InputJsonValue,
              fileHash: "",
              pHash: "",
              status: "PENDING",
            },
          });
        }),
      );

      await Promise.all(
        variations.map((v: any) =>
          sendMediaJob({
            type: "transform",
            organizationId: ctx.organizationId,
            sourceUrl: sourceVideo.url,
            transforms: v.transforms as Record<string, unknown>,
            outputKey: `variations/${v.id}`,
          }),
        ),
      );

      return variations;
    }),

  getVariations: onboardedProcedure
    .input(z.object({ sourceVideoId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertMultiplierEnabled(ctx);

      const sourceVideo = await ctx.db.sourceVideo.findUnique({
        where: { id: input.sourceVideoId },
        select: { organizationId: true },
      });
      if (!sourceVideo || sourceVideo.organizationId !== ctx.organizationId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Source video not found" });
      }

      return ctx.db.videoVariation.findMany({
        where: { sourceVideoId: input.sourceVideoId },
        orderBy: { variationIndex: "asc" },
      });
    }),

  scheduleDistribution: onboardedProcedure
    .input(
      z.object({
        variationIds: z.array(z.string()).min(1),
        accountIds: z.array(z.string()).min(1),
        startAt: z.date(),
        intervalMinutes: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertMultiplierEnabled(ctx);

      // Verify all variations belong to org
      const variations = await ctx.db.videoVariation.findMany({
        where: { id: { in: input.variationIds } },
        include: { sourceVideo: { select: { organizationId: true } } },
      });
      if (
        variations.length !== input.variationIds.length ||
        variations.some((v: any) => v.sourceVideo.organizationId !== ctx.organizationId)
      ) {
        throw new TRPCError({ code: "NOT_FOUND", message: "One or more variations not found" });
      }

      // Verify all accounts belong to org
      const accounts = await ctx.db.orgPlatformToken.findMany({
        where: { id: { in: input.accountIds }, organizationId: ctx.organizationId },
        select: { id: true, platform: true },
      });
      if (accounts.length !== input.accountIds.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "One or more accounts not found" });
      }

      // Create staggered PostRecord entries across accounts/variations
      const records: Array<{
        organizationId: string;
        accountId: string;
        variationId: string;
        platform: Platform;
        scheduledAt: Date;
      }> = [];

      let slotIndex = 0;
      for (const variationId of input.variationIds) {
        for (const account of accounts) {
          const scheduledAt = new Date(
            input.startAt.getTime() + slotIndex * input.intervalMinutes * 60_000,
          );
          records.push({
            organizationId: ctx.organizationId,
            accountId: account.id,
            variationId,
            platform: account.platform,
            scheduledAt,
          });
          slotIndex++;
        }
      }

      const created = await ctx.db.$transaction(
        records.map((r) => ctx.db.postRecord.create({ data: r })),
      );

      return created;
    }),

  getDistributionStatus: onboardedProcedure
    .input(z.object({ sourceVideoId: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      await assertMultiplierEnabled(ctx);

      const where: any = {};

      if (input.sourceVideoId) {
        // Verify ownership
        const sourceVideo = await ctx.db.sourceVideo.findUnique({
          where: { id: input.sourceVideoId },
          select: { organizationId: true },
        });
        if (!sourceVideo || sourceVideo.organizationId !== ctx.organizationId) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Source video not found" });
        }

        const variations = await ctx.db.videoVariation.findMany({
          where: { sourceVideoId: input.sourceVideoId },
          select: { id: true },
        });
        where.variationId = { in: variations.map((v: any) => v.id) };
      } else {
        // All posts for org's accounts
        const accounts = await ctx.db.orgPlatformToken.findMany({
          where: { organizationId: ctx.organizationId },
          select: { id: true },
        });
        where.accountId = { in: accounts.map((a: any) => a.id) };
      }

      const posts = await ctx.db.postRecord.findMany({
        where,
        orderBy: { scheduledAt: "asc" },
        include: {
          variation: { select: { variationIndex: true, sourceVideoId: true } },
          account: { select: { accountLabel: true, platform: true } },
        },
      });

      return posts;
    }),
});
