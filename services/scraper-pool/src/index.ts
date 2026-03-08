import { AgentPool } from "./pool.js";
import { ScrapeConsumer } from "./consumer.js";

const pool = new AgentPool();
const consumer = new ScrapeConsumer(pool);

async function main(): Promise<void> {
  console.log("[scraper-pool] starting...");

  await pool.init();
  console.log(`[scraper-pool] ready — ${pool.size} contexts warmed`);

  await consumer.start();
  console.log("[scraper-pool] consumer listening");

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.log(`[scraper-pool] received ${signal}, shutting down...`);
    await consumer.stop();
    await pool.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[scraper-pool] fatal error:", err);
  process.exit(1);
});

export { pool, consumer };
