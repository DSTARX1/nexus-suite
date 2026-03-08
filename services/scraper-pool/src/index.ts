import { AgentPool } from "./pool.js";

const pool = new AgentPool();

async function main(): Promise<void> {
  console.log("[scraper-pool] starting...");

  await pool.init();

  console.log(`[scraper-pool] ready — ${pool.size} contexts warmed`);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.log(`[scraper-pool] received ${signal}, shutting down...`);
    await pool.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep alive — consumer/queue integration added in Chunk 4
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[scraper-pool] fatal error:", err);
  process.exit(1);
});

export { pool };
