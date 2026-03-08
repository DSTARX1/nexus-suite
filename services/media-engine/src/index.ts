import { startConsumer } from "./queue.js";

async function main() {
  console.log("[media-engine] starting...");

  const boss = await startConsumer();

  const shutdown = async () => {
    console.log("[media-engine] shutting down...");
    await boss.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("[media-engine] ready");
}

main().catch((err) => {
  console.error("[media-engine] fatal:", err);
  process.exit(1);
});
