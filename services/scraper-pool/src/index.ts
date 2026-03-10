import http from "node:http";
import { Redis } from "ioredis";
import { AgentPool } from "./pool.js";
import { ScrapeConsumer } from "./consumer.js";
import { RateLimiter } from "./rate-limiter.js";
import { FingerprintRotator } from "./fingerprint-rotator.js";
import { ProxyManager } from "./proxy-manager.js";
import {
  initHashtagRoute,
  handleHashtagScrape,
  type HashtagScrapeRequest,
} from "./routes/hashtag.js";

const pool = new AgentPool();
const consumer = new ScrapeConsumer(pool);

const HTTP_PORT = parseInt(process.env.SCRAPER_HTTP_PORT ?? "3100", 10);

// ── HTTP helpers ─────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── HTTP server ──────────────────────────────────────────────

function createHttpServer(): http.Server {
  return http.createServer(async (req, res) => {
    const { method, url } = req;

    // Health check
    if (method === "GET" && url === "/health") {
      jsonResponse(res, 200, {
        status: "ok",
        pool: pool.size,
        available: pool.availableCount,
      });
      return;
    }

    // POST /scrape/hashtag
    if (method === "POST" && url === "/scrape/hashtag") {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as HashtagScrapeRequest;
        const result = await handleHashtagScrape(body);
        jsonResponse(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[http] /scrape/hashtag error:", message);
        jsonResponse(res, 500, { error: message });
      }
      return;
    }

    jsonResponse(res, 404, { error: "Not found" });
  });
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[scraper-pool] starting...");

  await pool.init();
  console.log(`[scraper-pool] ready — ${pool.size} contexts warmed`);

  // Initialize shared deps for HTTP routes
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379/0";
  const redis = new Redis(redisUrl);
  const rateLimiter = new RateLimiter(redis);
  const fpRotator = new FingerprintRotator(redis, pool);
  const proxyManager = new ProxyManager(redis);
  proxyManager.loadFromEnv();

  initHashtagRoute({ pool, rateLimiter, fpRotator, proxyManager });

  // Start queue consumer
  await consumer.start();
  console.log("[scraper-pool] consumer listening");

  // Start HTTP server for direct route endpoints
  const server = createHttpServer();
  server.listen(HTTP_PORT, () => {
    console.log(`[scraper-pool] HTTP server on :${HTTP_PORT}`);
  });

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.log(`[scraper-pool] received ${signal}, shutting down...`);
    server.close();
    await consumer.stop();
    redis.disconnect();
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
