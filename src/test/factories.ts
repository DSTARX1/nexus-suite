import { mockDeep } from "vitest-mock-extended";
import type { PrismaClient } from "@prisma/client";

// ── Mock Prisma Client ──────────────────────────────────────────
export const prismaMock = mockDeep<PrismaClient>();

// ── Factory: Organization ───────────────────────────────────────
let orgCounter = 0;
export function createOrganization(overrides: Record<string, unknown> = {}) {
  orgCounter++;
  return {
    id: `org_${orgCounter}`,
    name: `Test Org ${orgCounter}`,
    slug: `test-org-${orgCounter}`,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    stripeCustomerId: `cus_test_${orgCounter}`,
    stripeSubscriptionId: `sub_test_${orgCounter}`,
    setupPaymentIntentId: null,
    subscriptionStatus: "ACTIVE" as const,
    onboardingStatus: "ACTIVE" as const,
    pricingTier: "PRO" as const,
    maxAccounts: 3,
    maxWorkflowRuns: 50,
    maxVideosPerMonth: 30,
    mlFeaturesEnabled: false,
    multiplierEnabled: false,
    dailyLlmBudgetCents: 500,
    brandConfig: null,
    ...overrides,
  };
}

// ── Factory: User ───────────────────────────────────────────────
let userCounter = 0;
export function createUser(overrides: Record<string, unknown> = {}) {
  userCounter++;
  return {
    id: `user_${userCounter}`,
    name: `Test User ${userCounter}`,
    email: `user${userCounter}@test.com`,
    emailVerified: new Date("2026-01-01"),
    image: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

// ── Factory: OnboardingSubmission ────────────────────────────────
export function createOnboardingSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: `onb_${Date.now()}`,
    organizationId: "org_1",
    submittedAt: new Date("2026-01-01"),
    niche: "tech",
    brandVoice: "professional and concise",
    tonePreferences: "informative",
    competitorUrls: ["https://example.com"],
    platforms: ["YOUTUBE", "TIKTOK"],
    postingFrequency: "daily",
    contentStyle: "educational",
    additionalNotes: null,
    ...overrides,
  };
}

// ── Factory: StripeEvent ────────────────────────────────────────
export function createStripeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: `evt_test_${Date.now()}`,
    type: "checkout.session.completed",
    processedAt: new Date("2026-01-01"),
    organizationId: "org_1",
    payload: {},
    ...overrides,
  };
}
