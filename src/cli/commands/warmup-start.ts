import { db } from "@/lib/db";
import { enqueueWarmTask, getBoss, type WarmTask } from "@/server/services/warming/queue";

interface PhaseAction {
  action: string;
  weight: number;
}

interface PhaseConfig {
  phase: number;
  dayStart: number;
  dayEnd: number;
  sessionsPerDay: number;
  actions: PhaseAction[];
}

// 4-phase warming schedule matching warming-workflow.yaml
const PHASES: PhaseConfig[] = [
  {
    phase: 1,
    dayStart: 0,
    dayEnd: 3,
    sessionsPerDay: 2,
    actions: [
      { action: "scroll-feed", weight: 3 },
      { action: "watch-video", weight: 5 },
    ],
  },
  {
    phase: 2,
    dayStart: 3,
    dayEnd: 7,
    sessionsPerDay: 3,
    actions: [
      { action: "scroll-feed", weight: 2 },
      { action: "watch-video", weight: 3 },
      { action: "like-post", weight: 4 },
      { action: "follow-account", weight: 2 },
      { action: "post-comment", weight: 1 },
    ],
  },
  {
    phase: 3,
    dayStart: 7,
    dayEnd: 10,
    sessionsPerDay: 3,
    actions: [
      { action: "scroll-feed", weight: 2 },
      { action: "like-post", weight: 3 },
      { action: "follow-account", weight: 1 },
      { action: "post-comment", weight: 2 },
      { action: "post-video", weight: 1 },
    ],
  },
];

/**
 * Pick a random action from weighted list.
 */
function pickWeightedAction(actions: PhaseAction[]): string {
  const totalWeight = actions.reduce((sum, a) => sum + a.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const a of actions) {
    roll -= a.weight;
    if (roll <= 0) return a.action;
  }
  return actions[actions.length - 1].action;
}

/**
 * Generate a randomized Date offset within a day (between 8am-10pm).
 */
function randomTimeInDay(baseDate: Date, dayOffset: number): Date {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + dayOffset);
  // Random hour between 8:00 and 22:00
  const hour = 8 + Math.floor(Math.random() * 14);
  const minute = Math.floor(Math.random() * 60);
  d.setHours(hour, minute, 0, 0);
  return d;
}

export async function warmupStart(accountId: string) {
  console.log(`\n  Starting warmup for account: ${accountId}`);

  // 1. Load and validate account
  const account = await db.orgPlatformToken.findUnique({
    where: { id: accountId },
    include: { fingerprintProfile: true },
  });

  if (!account) {
    console.error(`  ERROR: Account ${accountId} not found`);
    process.exit(1);
  }

  if (account.accountType !== "SECONDARY") {
    console.error(`  ERROR: Warmup is for SECONDARY (burner) accounts only`);
    console.error(`  This account is type: ${account.accountType}`);
    process.exit(1);
  }

  if (!account.infisicalProxyPath) {
    console.error(`  ERROR: Account has no proxy assigned`);
    console.error(`  Run: admin assign-proxy ${accountId} <proxyUrl>`);
    process.exit(1);
  }

  if (!account.fingerprintProfile) {
    console.error(`  ERROR: Account has no fingerprint profile`);
    console.error(`  Provision fingerprint first`);
    process.exit(1);
  }

  if (account.warmupStatus === "WARMING") {
    console.error(`  ERROR: Account is already warming`);
    process.exit(1);
  }

  if (account.warmupStatus === "READY") {
    console.error(`  ERROR: Account is already warmed up`);
    process.exit(1);
  }

  // 2. Enqueue Phase 1-3 jobs with staggered startAfter
  const now = new Date();
  let totalJobs = 0;

  // Ensure pg-boss is initialized
  await getBoss();

  for (const phase of PHASES) {
    const days = phase.dayEnd - phase.dayStart;

    for (let day = 0; day < days; day++) {
      const actualDay = phase.dayStart + day;

      for (let session = 0; session < phase.sessionsPerDay; session++) {
        const action = pickWeightedAction(phase.actions);
        const startAfter = randomTimeInDay(now, actualDay);
        // Spread sessions within the day
        startAfter.setHours(startAfter.getHours() + session * 3);

        const task: WarmTask = {
          accountId,
          organizationId: account.organizationId,
          action,
          phase: phase.phase,
        };

        await enqueueWarmTask(task, {
          startAfter,
          singletonKey: `warm:${accountId}:d${actualDay}:s${session}`,
        });

        totalJobs++;
      }
    }
  }

  // Phase 4: mark-ready job after day 11
  const readyDate = randomTimeInDay(now, 11);
  await enqueueWarmTask(
    {
      accountId,
      organizationId: account.organizationId,
      action: "mark-ready",
      phase: 4,
    },
    {
      startAfter: readyDate,
      singletonKey: `warm:${accountId}:ready`,
    },
  );
  totalJobs++;

  // 3. Set warmupStatus = WARMING
  await db.orgPlatformToken.update({
    where: { id: accountId },
    data: { warmupStatus: "WARMING" },
  });

  console.log(`\n  ────────────────────────────────────────`);
  console.log(`  Warmup started successfully`);
  console.log(`  Account: ${account.accountLabel} (${account.platform})`);
  console.log(`  Jobs enqueued: ${totalJobs}`);
  console.log(`  Schedule: 10-day ramp across 3 phases + ready marker`);
  console.log(`  Status: WARMING`);
  console.log(`  Phase 1 (Days 1-3): Passive browsing`);
  console.log(`  Phase 2 (Days 4-7): Light engagement`);
  console.log(`  Phase 3 (Days 8-10): First posts`);
  console.log(`  Phase 4 (Day 11+): Mark READY\n`);
}
