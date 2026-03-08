import { Redis } from "ioredis";
import { db } from "@/lib/db";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0");

// ── Per-Model Pricing (cents per 1M tokens) ──────────────────────
// Cached in Redis for fast lookups. Prices from OpenRouter.
// Key: model identifier → { promptCentsPerMillion, completionCentsPerMillion }

interface ModelPricing {
  promptCentsPerMillion: number;
  completionCentsPerMillion: number;
}

const MODEL_PRICING_CACHE_KEY = "llm:pricing";
const MODEL_PRICING_TTL = 86400; // 24h cache

// Default pricing table — updated periodically or fetched from OpenRouter
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "anthropic/claude-opus-4-6":    { promptCentsPerMillion: 1500, completionCentsPerMillion: 7500 },
  "anthropic/claude-sonnet-4-6":  { promptCentsPerMillion: 300, completionCentsPerMillion: 1500 },
  "anthropic/claude-haiku-4-5":   { promptCentsPerMillion: 80, completionCentsPerMillion: 400 },
  // OpenAI
  "openai/gpt-4o":               { promptCentsPerMillion: 250, completionCentsPerMillion: 1000 },
  "openai/gpt-4o-mini":          { promptCentsPerMillion: 15, completionCentsPerMillion: 60 },
  "openai/gpt-4.1":              { promptCentsPerMillion: 200, completionCentsPerMillion: 800 },
  "openai/gpt-4.1-mini":         { promptCentsPerMillion: 40, completionCentsPerMillion: 160 },
  "openai/o3":                   { promptCentsPerMillion: 1000, completionCentsPerMillion: 4000 },
  "openai/o4-mini":              { promptCentsPerMillion: 110, completionCentsPerMillion: 440 },
  // Google
  "google/gemini-2.5-pro":       { promptCentsPerMillion: 125, completionCentsPerMillion: 1000 },
  "google/gemini-2.5-flash":     { promptCentsPerMillion: 15, completionCentsPerMillion: 60 },
  // Meta
  "meta-llama/llama-4-maverick": { promptCentsPerMillion: 20, completionCentsPerMillion: 60 },
  "meta-llama/llama-4-scout":    { promptCentsPerMillion: 15, completionCentsPerMillion: 60 },
  // DeepSeek
  "deepseek/deepseek-r1":        { promptCentsPerMillion: 55, completionCentsPerMillion: 220 },
  "deepseek/deepseek-chat-v3":   { promptCentsPerMillion: 27, completionCentsPerMillion: 110 },
};

async function getModelPricing(model: string): Promise<ModelPricing> {
  // Check Redis cache first
  const cached = await redis.hget(MODEL_PRICING_CACHE_KEY, model);
  if (cached) return JSON.parse(cached);

  // Fall back to default table
  const pricing = DEFAULT_PRICING[model];
  if (pricing) {
    // Cache for future lookups
    await redis.hset(MODEL_PRICING_CACHE_KEY, model, JSON.stringify(pricing));
    await redis.expire(MODEL_PRICING_CACHE_KEY, MODEL_PRICING_TTL);
    return pricing;
  }

  // Unknown model — use conservative estimate (GPT-4o pricing as ceiling)
  return { promptCentsPerMillion: 250, completionCentsPerMillion: 1000 };
}

// ── Spend Tracking ───────────────────────────────────────────────
// Redis key: llm:spend:{orgId}:{YYYY-MM-DD}
// Value: atomic counter in HUNDREDTHS of a cent (for precision without floats)
// TTL: 48h (auto-cleanup, auto-reset at midnight UTC)

function spendKey(orgId: string): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  return `llm:spend:${orgId}:${today}`;
}

/**
 * Track LLM spend after an API call completes.
 *
 * Uses EXACT math: cost = (promptTokens * promptPrice + completionTokens * completionPrice)
 * All arithmetic in integer hundredths-of-cents to avoid floating point drift.
 *
 * Example: 1000 prompt tokens on GPT-4o (250 cents / 1M tokens)
 *   costHundredths = (1000 * 25000) / 1_000_000 = 25 hundredths = 0.25 cents
 */
export async function trackLlmSpend(
  orgId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): Promise<{ spentCents: number; addedCents: number }> {
  const pricing = await getModelPricing(model);

  // Calculate cost in hundredths of a cent (integer math, no floats)
  // pricing is cents per 1M tokens → multiply by 100 for hundredths, then divide by 1M
  // costHundredths = (tokens * centsPerMillion * 100) / 1_000_000
  const promptCostHundredths = Math.ceil(
    (promptTokens * pricing.promptCentsPerMillion * 100) / 1_000_000,
  );
  const completionCostHundredths = Math.ceil(
    (completionTokens * pricing.completionCentsPerMillion * 100) / 1_000_000,
  );
  const totalHundredths = promptCostHundredths + completionCostHundredths;

  if (totalHundredths <= 0) {
    const current = await redis.get(spendKey(orgId));
    return {
      spentCents: hundredthsToCents(Number(current ?? 0)),
      addedCents: 0,
    };
  }

  // Atomic increment
  const key = spendKey(orgId);
  const newTotal = await redis.incrby(key, totalHundredths);

  // Set TTL on first write (48h — survives midnight, cleaned up next day)
  const ttl = await redis.ttl(key);
  if (ttl < 0) {
    await redis.expire(key, 172800); // 48 hours
  }

  const addedCents = hundredthsToCents(totalHundredths);
  const spentCents = hundredthsToCents(newTotal);

  return { spentCents, addedCents };
}

// ── Budget Check (Pre-flight) ────────────────────────────────────
// Called BEFORE every agent.generate() in the workflow executor

export interface BudgetCheckResult {
  allowed: boolean;
  spentCents: number;
  budgetCents: number;
  remainingCents: number;
  percentUsed: number;
  message?: string;
}

export async function checkLlmBudget(orgId: string): Promise<BudgetCheckResult> {
  // Get current spend from Redis
  const currentHundredths = Number(await redis.get(spendKey(orgId)) ?? 0);
  const spentCents = hundredthsToCents(currentHundredths);

  // Get org's daily budget from DB
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { dailyLlmBudgetCents: true, name: true },
  });

  if (!org) {
    return {
      allowed: false,
      spentCents,
      budgetCents: 0,
      remainingCents: 0,
      percentUsed: 100,
      message: `Organization ${orgId} not found`,
    };
  }

  const budgetCents = org.dailyLlmBudgetCents;
  const remainingCents = Math.max(0, budgetCents - spentCents);
  const percentUsed = budgetCents > 0 ? (spentCents / budgetCents) * 100 : 100;

  if (spentCents >= budgetCents) {
    return {
      allowed: false,
      spentCents,
      budgetCents,
      remainingCents: 0,
      percentUsed: Math.min(percentUsed, 100),
      message: `Daily LLM budget exceeded ($${(spentCents / 100).toFixed(2)} / $${(budgetCents / 100).toFixed(2)}). Workflows paused until midnight UTC.`,
    };
  }

  return {
    allowed: true,
    spentCents,
    budgetCents,
    remainingCents,
    percentUsed,
  };
}

// ── Get Spend Summary (for dashboard widget) ─────────────────────

export async function getSpendSummary(orgId: string): Promise<{
  spentCents: number;
  budgetCents: number;
  remainingCents: number;
  percentUsed: number;
  status: "green" | "yellow" | "red";
}> {
  const check = await checkLlmBudget(orgId);

  let status: "green" | "yellow" | "red";
  if (check.percentUsed >= 90) status = "red";
  else if (check.percentUsed >= 70) status = "yellow";
  else status = "green";

  return {
    spentCents: check.spentCents,
    budgetCents: check.budgetCents,
    remainingCents: check.remainingCents,
    percentUsed: check.percentUsed,
    status,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function hundredthsToCents(hundredths: number): number {
  return Math.round(hundredths / 100);
}
