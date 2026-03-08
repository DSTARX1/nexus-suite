import PgBoss from "pg-boss";
import { registerJobHandlers } from "./jobs/index.js";
import { startCompetitorWorker, stopCompetitorWorker } from "../workers/competitor-worker.js";
import { startPostWorker, stopPostWorker } from "../workers/post-worker.js";
import { startCompetitorPollingWorker, stopCompetitorPollingWorker } from "../workers/competitor-polling-worker.js";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const boss = new PgBoss(DATABASE_URL);

async function start(): Promise<void> {
  console.log("[worker] starting pg-boss...");
  await boss.start();
  registerJobHandlers(boss);

  console.log("[worker] starting competitor worker...");
  await startCompetitorWorker();

  console.log("[worker] starting post worker...");
  await startPostWorker();

  console.log("[worker] starting competitor polling worker...");
  await startCompetitorPollingWorker();

  console.log("[worker] ready");
}

async function shutdown(): Promise<void> {
  console.log("[worker] shutting down...");
  await stopCompetitorWorker();
  await stopCompetitorPollingWorker();
  await stopPostWorker();
  await boss.stop();
  console.log("[worker] stopped");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
