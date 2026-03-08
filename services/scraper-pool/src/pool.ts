import { chromium, type Browser, type BrowserContext } from "patchright";
import { generateBrowserProfile } from "./fingerprint.js";

interface PooledContext {
  context: BrowserContext;
  id: string;
  taskCount: number;
}

/**
 * AgentPool — manages pre-warmed Patchright BrowserContext instances
 * behind an async semaphore for bounded concurrency.
 */
export class AgentPool {
  private browser: Browser | null = null;
  private contexts: PooledContext[] = [];
  private available: PooledContext[] = [];
  private waitQueue: Array<(ctx: PooledContext) => void> = [];
  private poolSize: number;
  private contextIdCounter = 0;
  private shuttingDown = false;

  constructor(poolSize?: number) {
    this.poolSize = poolSize ?? parseInt(process.env.POOL_SIZE ?? "8", 10);
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
      ],
    });

    const createPromises: Promise<PooledContext>[] = [];
    for (let i = 0; i < this.poolSize; i++) {
      createPromises.push(this.createContext());
    }
    await Promise.all(createPromises);

    console.log(`[AgentPool] initialized with ${this.poolSize} contexts`);
  }

  private async createContext(): Promise<PooledContext> {
    if (!this.browser) throw new Error("Browser not initialized");

    const profile = generateBrowserProfile();
    const id = `ctx-${++this.contextIdCounter}`;

    const context = await this.browser.newContext({
      userAgent: profile.userAgent,
      viewport: { width: profile.screenWidth, height: profile.screenHeight },
      locale: profile.locale,
      timezoneId: profile.timezone,
      permissions: [],
      extraHTTPHeaders: {
        "Accept-Language": profile.languages.join(","),
      },
    });

    // Inject fingerprint overrides into every new page
    await context.addInitScript(`
      Object.defineProperty(navigator, 'platform', { get: () => '${profile.platform}' });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${profile.hardwareConcurrency} });
      Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(profile.languages)} });
    `);

    const pooled: PooledContext = { context, id, taskCount: 0 };
    this.contexts.push(pooled);
    this.available.push(pooled);

    return pooled;
  }

  /**
   * Acquire a context from the pool. Waits if none available (semaphore).
   */
  async acquire(): Promise<{ context: BrowserContext; id: string }> {
    if (this.shuttingDown) throw new Error("Pool is shutting down");

    const pooled = this.available.pop();
    if (pooled) {
      pooled.taskCount++;
      return { context: pooled.context, id: pooled.id };
    }

    // No context available — wait in queue (async semaphore)
    return new Promise((resolve) => {
      this.waitQueue.push((ctx) => {
        ctx.taskCount++;
        resolve({ context: ctx.context, id: ctx.id });
      });
    });
  }

  /**
   * Release a context back to the pool.
   */
  release(id: string): void {
    const pooled = this.contexts.find((c) => c.id === id);
    if (!pooled) return;

    // If someone is waiting, hand off directly
    const waiter = this.waitQueue.shift();
    if (waiter) {
      waiter(pooled);
      return;
    }

    this.available.push(pooled);
  }

  /**
   * Recycle a context — close it and create a fresh one with new fingerprint.
   * Used by fingerprint rotation after N tasks.
   */
  async recycle(id: string): Promise<void> {
    const idx = this.contexts.findIndex((c) => c.id === id);
    if (idx === -1) return;

    const old = this.contexts[idx];
    await old.context.close().catch(() => {});

    // Remove from contexts and available arrays
    this.contexts.splice(idx, 1);
    const availIdx = this.available.findIndex((c) => c.id === id);
    if (availIdx !== -1) this.available.splice(availIdx, 1);

    // Create replacement
    const fresh = await this.createContext();

    // If someone is waiting, hand off the fresh context
    const waiter = this.waitQueue.shift();
    if (waiter) {
      // Remove from available since we're handing it off
      const freshAvailIdx = this.available.findIndex((c) => c.id === fresh.id);
      if (freshAvailIdx !== -1) this.available.splice(freshAvailIdx, 1);
      waiter(fresh);
    }
  }

  /**
   * Get task count for a context (used by fingerprint rotator).
   */
  getTaskCount(id: string): number {
    return this.contexts.find((c) => c.id === id)?.taskCount ?? 0;
  }

  /**
   * Gracefully shut down — close all contexts and browser.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Reject all waiters
    for (const waiter of this.waitQueue) {
      // Create a dummy that will throw when used
      waiter({ context: null as unknown as BrowserContext, id: "shutdown", taskCount: 0 });
    }
    this.waitQueue = [];

    // Close all contexts
    await Promise.allSettled(
      this.contexts.map((c) => c.context.close().catch(() => {}))
    );
    this.contexts = [];
    this.available = [];

    // Close browser
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    console.log("[AgentPool] shutdown complete");
  }

  get size(): number {
    return this.contexts.length;
  }

  get availableCount(): number {
    return this.available.length;
  }

  get waitingCount(): number {
    return this.waitQueue.length;
  }
}
