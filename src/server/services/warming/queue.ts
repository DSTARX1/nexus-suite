import PgBoss from "pg-boss";
import { recordAction } from "./health-tracker";

// ── pg-boss instance (singleton) ────────────────────────────────

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;

  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL!,
    schema: "pgboss",
    retryLimit: 3,
    retryDelay: 30, // seconds
    expireInHours: 24,
    archiveCompletedAfterSeconds: 7 * 86400, // 7 days
    deleteAfterDays: 30,
  });

  boss.on("error", (err) => console.error("[pg-boss] error:", err));

  await boss.start();
  return boss;
}

// ── Task shape ──────────────────────────────────────────────────

export interface WarmTask {
  accountId: string;
  organizationId: string;
  action: string; // e.g. "scroll-feed", "like-post", "follow-account", "post-video"
  phase: number; // 1-4
  params?: Record<string, unknown>;
}

export const WARM_TASK_QUEUE = "warm:task";

// ── Consumer ────────────────────────────────────────────────────

export type WarmTaskHandler = (task: WarmTask) => Promise<void>;

export async function startConsumer(handler: WarmTaskHandler): Promise<void> {
  const b = await getBoss();

  await b.work<WarmTask>(
    WARM_TASK_QUEUE,
    { batchSize: 1 }, // one task at a time (browser automation)
    async (jobs) => {
      for (const job of jobs) {
        const task = job.data;
        console.log(
          `[warm:task] Processing ${task.action} for account ${task.accountId} (phase ${task.phase})`,
        );

        try {
          await handler(task);
          await recordAction(task.accountId, task.phase);
        } catch (err) {
          console.error(`[warm:task] Failed ${task.action} for ${task.accountId}:`, err);
          throw err; // pg-boss retries
        }
      }
    },
  );

  console.log(`[warm:task] Consumer listening on "${WARM_TASK_QUEUE}"`);
}

// ── Producer helpers ────────────────────────────────────────────

export async function enqueueWarmTask(
  task: WarmTask,
  options?: { startAfter?: Date; singletonKey?: string },
): Promise<string | null> {
  const b = await getBoss();
  return b.send(WARM_TASK_QUEUE, task, {
    startAfter: options?.startAfter,
    singletonKey: options?.singletonKey,
    retryLimit: 3,
    retryDelay: 60,
    expireInMinutes: 30,
  });
}

export async function stopBoss(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 10_000 });
    boss = null;
  }
}
