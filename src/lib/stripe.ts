import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-02-24.acacia",
});

// Stripe Price IDs (configured in Stripe Dashboard)
// Each tier has a one-time setup fee + recurring subscription price
export const PRICING = {
  PRO: {
    setupPriceId: process.env.STRIPE_PRO_SETUP_PRICE_ID!,
    subscriptionPriceId: process.env.STRIPE_PRO_SUBSCRIPTION_PRICE_ID!,
    features: {
      maxAccounts: 3,
      maxWorkflowRuns: 50,
      maxVideosPerMonth: 30,
      mlFeaturesEnabled: false,
      multiplierEnabled: false,
      dailyLlmBudgetCents: 500,
    },
  },
  MULTIPLIER: {
    setupPriceId: process.env.STRIPE_MULTIPLIER_SETUP_PRICE_ID!,
    subscriptionPriceId: process.env.STRIPE_MULTIPLIER_SUBSCRIPTION_PRICE_ID!,
    features: {
      maxAccounts: 25,
      maxWorkflowRuns: 500,
      maxVideosPerMonth: 300,
      mlFeaturesEnabled: true,
      multiplierEnabled: true,
      dailyLlmBudgetCents: 1500,
    },
  },
  ENTERPRISE: {
    setupPriceId: process.env.STRIPE_ENTERPRISE_SETUP_PRICE_ID!,
    subscriptionPriceId: process.env.STRIPE_ENTERPRISE_SUBSCRIPTION_PRICE_ID!,
    features: {
      maxAccounts: 9999,
      maxWorkflowRuns: 9999,
      maxVideosPerMonth: 9999,
      mlFeaturesEnabled: true,
      multiplierEnabled: true,
      dailyLlmBudgetCents: 10000,
    },
  },
} as const;

export type PricingTier = keyof typeof PRICING;

// Resolve tier from Stripe subscription price ID
export function resolveTierFromPriceId(priceId: string): PricingTier | null {
  for (const [tier, config] of Object.entries(PRICING)) {
    if (config.subscriptionPriceId === priceId) {
      return tier as PricingTier;
    }
  }
  return null;
}
