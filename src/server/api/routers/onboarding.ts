import { z } from "zod";
import { createTRPCRouter, authedProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";

const onboardingSchema = z.object({
  niche: z.string().min(2, "Niche is required").max(200),
  brandVoice: z.string().max(2000).optional(),
  tonePreferences: z.string().max(1000).optional(),
  competitorUrls: z
    .array(z.string().url("Must be a valid URL"))
    .min(0)
    .max(20),
  platforms: z
    .array(z.enum(["YOUTUBE", "TIKTOK", "INSTAGRAM", "LINKEDIN", "X", "FACEBOOK"]))
    .min(1, "Select at least one platform"),
  postingFrequency: z.string().max(100).optional(),
  contentStyle: z.string().max(200).optional(),
  additionalNotes: z.string().max(2000).optional(),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;

export const onboardingRouter = createTRPCRouter({
  // Submit onboarding wizard data
  submit: authedProcedure.input(onboardingSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.organizationId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Complete checkout before onboarding",
      });
    }

    // Check org is in correct state
    const org = await ctx.db.organization.findUnique({
      where: { id: ctx.organizationId },
    });

    if (!org) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });
    }

    if (org.onboardingStatus === "ACTIVE") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Onboarding already completed",
      });
    }

    // Upsert: allow re-submission if they go back and edit
    await ctx.db.onboardingSubmission.upsert({
      where: { organizationId: ctx.organizationId },
      create: {
        organizationId: ctx.organizationId,
        niche: input.niche,
        brandVoice: input.brandVoice,
        tonePreferences: input.tonePreferences,
        competitorUrls: input.competitorUrls,
        platforms: input.platforms,
        postingFrequency: input.postingFrequency,
        contentStyle: input.contentStyle,
        additionalNotes: input.additionalNotes,
      },
      update: {
        niche: input.niche,
        brandVoice: input.brandVoice,
        tonePreferences: input.tonePreferences,
        competitorUrls: input.competitorUrls,
        platforms: input.platforms,
        postingFrequency: input.postingFrequency,
        contentStyle: input.contentStyle,
        additionalNotes: input.additionalNotes,
      },
    });

    // Transition: PENDING_PAYMENT → PENDING_SETUP (form submitted, awaiting admin)
    if (org.onboardingStatus === "PENDING_PAYMENT" || org.onboardingStatus === "PENDING_SETUP") {
      await ctx.db.organization.update({
        where: { id: ctx.organizationId },
        data: { onboardingStatus: "PENDING_SETUP" },
      });
    }

    return { success: true };
  }),

  // Get existing submission (for pre-filling if user returns)
  get: authedProcedure.query(async ({ ctx }) => {
    if (!ctx.organizationId) return null;

    return ctx.db.onboardingSubmission.findUnique({
      where: { organizationId: ctx.organizationId },
    });
  }),
});
