import { z } from "zod";
import { createTRPCRouter, onboardedProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";

export const settingsRouter = createTRPCRouter({
  // Org details (name, slug, tier, limits)
  getOrgDetails: onboardedProcedure.query(async ({ ctx }) => {
    const org = await ctx.db.organization.findUnique({
      where: { id: ctx.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        pricingTier: true,
        maxAccounts: true,
        maxWorkflowRuns: true,
        maxVideosPerMonth: true,
        mlFeaturesEnabled: true,
        multiplierEnabled: true,
        dailyLlmBudgetCents: true,
        brandConfig: true,
        createdAt: true,
      },
    });

    if (!org) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });
    }

    return org;
  }),

  // Update org name/slug
  updateOrgDetails: onboardedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100).optional(),
        slug: z
          .string()
          .min(2)
          .max(50)
          .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens")
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.slug) {
        const existing = await ctx.db.organization.findUnique({
          where: { slug: input.slug },
        });
        if (existing && existing.id !== ctx.organizationId) {
          throw new TRPCError({ code: "CONFLICT", message: "Slug already taken" });
        }
      }

      const updated = await ctx.db.organization.update({
        where: { id: ctx.organizationId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.slug !== undefined && { slug: input.slug }),
        },
        select: { id: true, name: true, slug: true },
      });

      return updated;
    }),

  // Platform connections with health indicators
  listPlatformTokens: onboardedProcedure.query(async ({ ctx }) => {
    return ctx.db.orgPlatformToken.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        platform: true,
        accountLabel: true,
        accountType: true,
        healthScore: true,
        circuitState: true,
        warmupStatus: true,
        lastSuccessAt: true,
        lastFailureAt: true,
        createdAt: true,
      },
      orderBy: [{ platform: "asc" }, { accountType: "asc" }],
    });
  }),

  // Update brand config JSON
  updateBrandConfig: onboardedProcedure
    .input(
      z.object({
        brandConfig: z.record(z.unknown()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.organization.update({
        where: { id: ctx.organizationId },
        data: { brandConfig: input.brandConfig as unknown as import("@prisma/client").Prisma.InputJsonValue },
      });

      return { success: true };
    }),
});
