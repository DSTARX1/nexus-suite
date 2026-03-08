import type { Redis } from "ioredis";

interface ProxyEntry {
  url: string;
  failures: number;
  burned: boolean;
}

const MAX_CONSECUTIVE_FAILURES = 5;
const STICKY_TTL_SECONDS = 3600; // 1 hour

export class ProxyManager {
  private redis: Redis;
  private proxies: ProxyEntry[] = [];

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Load proxy list from environment or a provided list.
   * Format: comma-separated proxy URLs.
   */
  loadFromEnv(): void {
    const endpoint = process.env.PROXY_RESIDENTIAL_ENDPOINT;
    if (!endpoint) {
      console.warn("[ProxyManager] no PROXY_RESIDENTIAL_ENDPOINT set");
      return;
    }

    // Support comma-separated list or single rotating endpoint
    const urls = endpoint.split(",").map((u) => u.trim()).filter(Boolean);
    this.proxies = urls.map((url) => ({ url, failures: 0, burned: false }));
    console.log(`[ProxyManager] loaded ${this.proxies.length} proxies`);
  }

  loadFromList(urls: string[]): void {
    this.proxies = urls.map((url) => ({ url, failures: 0, burned: false }));
  }

  /**
   * Get a proxy for a domain. Uses sticky assignment if one exists.
   * Falls back to round-robin from healthy proxies.
   */
  async getProxy(domain: string): Promise<string | null> {
    if (this.proxies.length === 0) return null;

    const stickyKey = `scraper:proxy:sticky:${domain}`;

    // Check sticky assignment
    const sticky = await this.redis.get(stickyKey);
    if (sticky) {
      const entry = this.proxies.find((p) => p.url === sticky && !p.burned);
      if (entry) return entry.url;
    }

    // Pick from healthy proxies
    const healthy = this.proxies.filter((p) => !p.burned);
    if (healthy.length === 0) {
      console.error("[ProxyManager] all proxies burned");
      return null;
    }

    const picked = healthy[Math.floor(Math.random() * healthy.length)];

    // Set sticky assignment
    await this.redis.set(stickyKey, picked.url, "EX", STICKY_TTL_SECONDS);

    return picked.url;
  }

  /**
   * Report success for a proxy — resets failure counter.
   */
  reportSuccess(proxyUrl: string): void {
    const entry = this.proxies.find((p) => p.url === proxyUrl);
    if (entry) entry.failures = 0;
  }

  /**
   * Report failure for a proxy — increments counter, burns after threshold.
   */
  reportFailure(proxyUrl: string): void {
    const entry = this.proxies.find((p) => p.url === proxyUrl);
    if (!entry) return;

    entry.failures++;
    if (entry.failures >= MAX_CONSECUTIVE_FAILURES) {
      entry.burned = true;
      console.warn(`[ProxyManager] proxy burned: ${proxyUrl}`);
    }
  }

  get healthyCount(): number {
    return this.proxies.filter((p) => !p.burned).length;
  }

  get totalCount(): number {
    return this.proxies.length;
  }
}
