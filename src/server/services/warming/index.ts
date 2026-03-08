/**
 * Warming Service Entry Point
 *
 * Runs when SERVICE_MODE=warming (docker-compose warming-service container).
 * Starts pg-boss consumer that listens for warm:task jobs and dispatches
 * to the executor (Chunk 2).
 */

import { startConsumer, stopBoss, type WarmTask } from "./queue";
import { isStale, flagStale } from "./health-tracker";
import { executeWarmTask, disposeExecutor } from "./executor";

// ── Task handler — dispatches to executor ──────────────────────

async function handleWarmTask(task: WarmTask): Promise<void> {
  if (await isStale(task.accountId)) {
    await flagStale(task.accountId);
    console.warn(
      `[warming] Account ${task.accountId} is stale (>7d since last action). Flagging.`,
    );
  }

  await executeWarmTask(task);
}

// ── Bootstrap ──────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[warming] Starting warming service...");

  await startConsumer(handleWarmTask);

  console.log("[warming] Warming service running. Waiting for tasks...");
}

// ── Graceful shutdown ──────────────────────────────────────────

function shutdown(signal: string) {
  return async () => {
    console.log(`[warming] Received ${signal}, shutting down...`);
    await disposeExecutor();
    await stopBoss();
    process.exit(0);
  };
}

process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));

// ── Only run if SERVICE_MODE=warming ───────────────────────────

if (process.env.SERVICE_MODE === "warming") {
  main().catch((err) => {
    console.error("[warming] Fatal error:", err);
    process.exit(1);
  });
}

export { main as startWarmingService };
