import PgBoss from "pg-boss";
import { Worker } from "bullmq";
import { registerJobHandlers } from "./jobs/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!REDIS_URL) throw new Error("REDIS_URL is required");

const boss = new PgBoss(DATABASE_URL);

const bullWorkers: Worker[] = [];

async function start(): Promise<void> {
  console.log("[worker] starting pg-boss...");
  await boss.start();
  registerJobHandlers(boss);

  console.log("[worker] connecting to Redis for BullMQ...");
  const bullWorker = new Worker(
    "default",
    async (job) => {
      console.log(`[worker] bullmq job=${job.id} name=${job.name}`);
    },
    { connection: { url: REDIS_URL } },
  );
  bullWorkers.push(bullWorker);

  console.log("[worker] ready");
}

async function shutdown(): Promise<void> {
  console.log("[worker] shutting down...");
  for (const w of bullWorkers) {
    await w.close();
  }
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
