import { db } from "@/lib/db";
import { checkLlmBudget, type BudgetCheckResult } from "./llm-budget";

// ── Types ────────────────────────────────────────────────────────

type CountMetric = "accounts" | "workflow_runs" | "videos";
type Metric = CountMetric | "llm_spend_cents";

export interface UsageLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  message?: string;
}

// ── Feature gate → metric mapping ────────────────────────────────

const METRIC_TO_GATE: Record<CountMetric, "maxAccounts" | "maxWorkflowRuns" | "maxVideosPerMonth"> = {
  accounts: "maxAccounts",
  workflow_runs: "maxWorkflowRuns",
  videos: "maxVideosPerMonth",
};

// ── Period helpers ───────────────────────────────────────────────

function monthlyPeriod(): string {
  return new Date().toISOString().slice(0, 7); // "2026-03"
}

function dailyPeriod(): string {
  return new Date().toISOString().slice(0, 10); // "2026-03-07"
}

function periodForMetric(metric: Metric): string {
  return metric === "llm_spend_cents" ? dailyPeriod() : monthlyPeriod();
}

// ── Increment Usage ──────────────────────────────────────────────

export async function incrementUsage(
  orgId: string,
  metric: Metric,
  period?: string,
): Promise<number> {
  const p = period ?? periodForMetric(metric);

  const record = await db.usageRecord.upsert({
    where: {
      organizationId_metric_period: {
        organizationId: orgId,
        metric,
        period: p,
      },
    },
    create: {
      organizationId: orgId,
      metric,
      period: p,
      count: 1,
    },
    update: {
      count: { increment: 1 },
    },
  });

  return record.count;
}

// ── Check Usage Limit ────────────────────────────────────────────

export async function checkUsageLimit(
  orgId: string,
  metric: Metric,
): Promise<UsageLimitResult> {
  // LLM spend delegates to existing budget service
  if (metric === "llm_spend_cents") {
    const budget: BudgetCheckResult = await checkLlmBudget(orgId);
    return {
      allowed: budget.allowed,
      current: budget.spentCents,
      limit: budget.budgetCents,
      message: budget.message,
    };
  }

  // Count-based metrics
  const period = periodForMetric(metric);
  const record = await db.usageRecord.findUnique({
    where: {
      organizationId_metric_period: {
        organizationId: orgId,
        metric,
        period,
      },
    },
    select: { count: true },
  });

  const current = record?.count ?? 0;

  // Get org limit
  const gate = METRIC_TO_GATE[metric];
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { [gate]: true },
  });

  const limit = (org?.[gate] as unknown as number) ?? 0;

  if (current >= limit) {
    return {
      allowed: false,
      current,
      limit,
      message: `${metric} limit reached (${current}/${limit}). Upgrade your plan for more.`,
    };
  }

  return { allowed: true, current, limit };
}
