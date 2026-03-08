import PgBoss from "pg-boss";
import { Redis } from "ioredis";
import { AgentPool } from "./pool.js";
import { RateLimiter } from "./rate-limiter.js";
import { FingerprintRotator } from "./fingerprint-rotator.js";
import { ProxyManager } from "./proxy-manager.js";
import { runBypassChain } from "./bypass/chain.js";
import { ProgressStream } from "./stream.js";

const TASK_QUEUE = "scrape:task";
const RESULT_QUEUE = "scrape:result";

interface ScrapeTask {
  taskId: string;
  url: string;
  options?: {
    priority?: number;
    timeout?: number;
  };
}

interface ScrapeResult {
  taskId: string;
  html: string;
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  meta: {
    strategy: string;
    durationMs: number;
    url: string;
  };
}

/**
 * Queue consumer — connects to pg-boss, subscribes to scrape:task,
 * runs bypass chain, publishes results to scrape:result.
 */
export class ScrapeConsumer {
  private boss: PgBoss;
  private redis: Redis;
  private pool: AgentPool;
  private rateLimiter: RateLimiter;
  private fpRotator: FingerprintRotator;
  private proxyManager: ProxyManager;
  private stream: ProgressStream;

  constructor(pool: AgentPool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL required");

    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379/0";

    this.boss = new PgBoss(databaseUrl);
    this.redis = new Redis(redisUrl);
    this.pool = pool;
    this.rateLimiter = new RateLimiter(this.redis);
    this.fpRotator = new FingerprintRotator(this.redis, pool);
    this.proxyManager = new ProxyManager(this.redis);
    this.stream = new ProgressStream(this.redis);
  }

  async start(): Promise<void> {
    this.proxyManager.loadFromEnv();

    await this.boss.start();
    console.log("[ScrapeConsumer] pg-boss started");

    await this.boss.work<ScrapeTask>(
      TASK_QUEUE,
      { pollingIntervalSeconds: 1, batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) {
          await this.handleTask(job.data);
        }
      },
    );

    console.log(`[ScrapeConsumer] listening on queue: ${TASK_QUEUE}`);
  }

  private async handleTask(task: ScrapeTask): Promise<void> {
    const { taskId, url } = task;
    const domain = new URL(url).hostname;
    const startTime = Date.now();

    await this.stream.started(taskId);

    // Rate limit per domain
    await this.rateLimiter.acquireToken(domain);

    // Acquire browser context from pool
    const { context, id: contextId } = await this.pool.acquire();

    try {
      // Run bypass chain with progress streaming
      const result = await runBypassChain({
        url,
        context,
        redis: this.redis,
        onStrategy: (strategy) => {
          void this.stream.strategy(taskId, strategy);
          if (strategy.includes("captcha") || strategy === "turnstile" || strategy === "recaptcha") {
            void this.stream.captchaSolving(taskId);
          }
        },
      });

      const scrapeResult: ScrapeResult = {
        taskId,
        html: result.html,
        cookies: result.cookies,
        meta: {
          strategy: result.strategy,
          durationMs: Date.now() - startTime,
          url,
        },
      };

      // Publish result to result queue
      await this.boss.send(RESULT_QUEUE, scrapeResult);
      await this.stream.success(taskId);

      console.log(
        `[ScrapeConsumer] task ${taskId} done — ${result.strategy} — ${Date.now() - startTime}ms`,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.stream.failed(taskId, error);

      // Publish failure to result queue so caller knows
      await this.boss.send(RESULT_QUEUE, {
        taskId,
        html: "",
        cookies: [],
        meta: {
          strategy: "failed",
          durationMs: Date.now() - startTime,
          url,
          error,
        },
      });

      console.error(`[ScrapeConsumer] task ${taskId} failed:`, error);
    } finally {
      // Release context back to pool
      this.pool.release(contextId);

      // Fingerprint rotation check
      await this.fpRotator.trackAndRotate(contextId);
    }
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true });
    this.redis.disconnect();
    console.log("[ScrapeConsumer] stopped");
  }
}
