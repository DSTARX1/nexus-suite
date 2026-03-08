import { z } from "zod";
import { createTRPCRouter, adminProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";

export const adminRouter = createTRPCRouter({
  // List all orgs with status info for admin data table
  listOrgs: adminProcedure
    .input(
      z
        .object({
          cursor: z.string().optional(),
          limit: z.number().min(1).max(100).default(25),
          statusFilter: z.enum(["ALL", "PENDING_SETUP", "ACTIVE", "SUSPENDED"]).default("ALL"),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const { cursor, limit = 25, statusFilter = "ALL" } = input ?? {};

      const where =
        statusFilter !== "ALL" ? { onboardingStatus: statusFilter as any } : {};

      const orgs = await ctx.db.organization.findMany({
        where,
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { createdAt: "desc" },
        include: {
          members: {
            where: { role: "OWNER" },
            include: { user: { select: { email: true, name: true } } },
            take: 1,
          },
          onboardingSubmission: {
            select: { niche: true, submittedAt: true },
          },
          _count: { select: { platformTokens: true } },
        },
      });

      let nextCursor: string | undefined;
      if (orgs.length > limit) {
        const next = orgs.pop();
        nextCursor = next?.id;
      }

      return {
        orgs: orgs.map((org) => ({
          id: org.id,
          name: org.name,
          slug: org.slug,
          ownerEmail: org.members[0]?.user.email ?? "—",
          ownerName: org.members[0]?.user.name ?? "—",
          pricingTier: org.pricingTier,
          subscriptionStatus: org.subscriptionStatus,
          onboardingStatus: org.onboardingStatus,
          niche: org.onboardingSubmission?.niche ?? "—",
          onboardingSubmittedAt: org.onboardingSubmission?.submittedAt ?? null,
          accountCount: org._count.platformTokens,
          createdAt: org.createdAt,
        })),
        nextCursor,
      };
    }),

  // Toggle onboardingStatus: PENDING_SETUP → ACTIVE (or ACTIVE → SUSPENDED)
  setOnboardingStatus: adminProcedure
    .input(
      z.object({
        orgId: z.string(),
        status: z.enum(["ACTIVE", "SUSPENDED", "PENDING_SETUP"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const org = await ctx.db.organization.findUnique({
        where: { id: input.orgId },
      });

      if (!org) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });
      }

      // Guard: can't activate without onboarding submission
      if (input.status === "ACTIVE" && !org.onboardingStatus) {
        const submission = await ctx.db.onboardingSubmission.findUnique({
          where: { organizationId: input.orgId },
        });
        if (!submission) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Cannot activate — client hasn't submitted onboarding form yet",
          });
        }
      }

      await ctx.db.organization.update({
        where: { id: input.orgId },
        data: { onboardingStatus: input.status },
      });

      return { success: true, orgId: input.orgId, newStatus: input.status };
    }),
});
