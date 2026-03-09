import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";
import { authConfig } from "./auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(db),
  callbacks: {
    ...authConfig.callbacks,
    // Layer 2: Session callback — inject org status into session
    // Blocks login entirely if subscription is CANCELED/INACTIVE
    async session({ session, user }) {
      // Find user's org membership (primary = first OWNER membership)
      const membership = await db.orgMember.findFirst({
        where: { userId: user.id },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              subscriptionStatus: true,
              onboardingStatus: true,
              pricingTier: true,
              maxAccounts: true,
              maxWorkflowRuns: true,
              maxVideosPerMonth: true,
              mlFeaturesEnabled: true,
              multiplierEnabled: true,
              dailyLlmBudgetCents: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      session.user.id = user.id;

      if (membership) {
        const org = membership.organization;

        // Layer 2 gate: block if subscription is dead
        const blockedStatuses = ["CANCELED", "INACTIVE", "UNPAID"];
        if (blockedStatuses.includes(org.subscriptionStatus)) {
          // Return session without org — frontend redirects to /reactivate
          session.user.orgBlocked = true;
          session.user.blockReason = "subscription_inactive";
          return session;
        }

        session.user.organizationId = org.id;
        session.user.organizationName = org.name;
        session.user.organizationSlug = org.slug;
        session.user.role = membership.role;
        session.user.subscriptionStatus = org.subscriptionStatus;
        session.user.onboardingStatus = org.onboardingStatus;
        session.user.pricingTier = org.pricingTier;

        // Denormalized feature gates for client-side checks
        session.user.features = {
          maxAccounts: org.maxAccounts,
          maxWorkflowRuns: org.maxWorkflowRuns,
          maxVideosPerMonth: org.maxVideosPerMonth,
          mlFeaturesEnabled: org.mlFeaturesEnabled,
          multiplierEnabled: org.multiplierEnabled,
          dailyLlmBudgetCents: org.dailyLlmBudgetCents,
        };
      }

      return session;
    },
  },
});

// ── Type Augmentation ────────────────────────────────────────────

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      organizationId?: string;
      organizationName?: string;
      organizationSlug?: string;
      role?: string;
      subscriptionStatus?: string;
      onboardingStatus?: string;
      pricingTier?: string;
      orgBlocked?: boolean;
      blockReason?: string;
      features?: {
        maxAccounts: number;
        maxWorkflowRuns: number;
        maxVideosPerMonth: number;
        mlFeaturesEnabled: boolean;
        multiplierEnabled: boolean;
        dailyLlmBudgetCents: number;
      };
    };
  }
}
