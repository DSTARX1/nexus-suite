import type { AgentPool } from "../pool.js";
import type { RateLimiter } from "../rate-limiter.js";
import type { FingerprintRotator } from "../fingerprint-rotator.js";
import type { ProxyManager } from "../proxy-manager.js";

// ── Types ────────────────────────────────────────────────────

export interface HashtagScrapeRequest {
  hashtag: string;
  platform: string;
  limit?: number;
}

export interface ScrapedHashtagPost {
  url: string | null;
  description: string | null;
  creator: string | null;
  views: string | null;
  likes: string | null;
  comments: string | null;
  sound: string | null;
  thumbnail: string | null;
}

export interface HashtagScrapeResponse {
  posts: ScrapedHashtagPost[];
  count: number;
  hashtag: string;
  platform: string;
}

// ── Deps injected from server setup ─────────────────────────

export interface HashtagRouteDeps {
  pool: AgentPool;
  rateLimiter: RateLimiter;
  fpRotator: FingerprintRotator;
  proxyManager: ProxyManager;
}

let deps: HashtagRouteDeps | null = null;

export function initHashtagRoute(d: HashtagRouteDeps): void {
  deps = d;
}

// ── Handler ─────────────────────────────────────────────────

export async function handleHashtagScrape(
  body: HashtagScrapeRequest,
): Promise<HashtagScrapeResponse> {
  if (!deps) throw new Error("Hashtag route not initialized");

  const { hashtag, platform, limit = 20 } = body;
  const tag = hashtag.replace(/^#/, "");

  if (!tag) {
    throw new Error("Missing or empty 'hashtag' field");
  }

  if (platform.toLowerCase() !== "tiktok") {
    throw new Error(`Hashtag scraping not supported for platform: ${platform}`);
  }

  const url = `https://www.tiktok.com/tag/${encodeURIComponent(tag)}`;
  const domain = "www.tiktok.com";

  // Rate limit for tiktok domain
  await deps.rateLimiter.acquireToken(domain);

  // Resolve proxy
  const proxyUrl = await deps.proxyManager.getProxy(domain);

  // Acquire browser context from pool
  const { context, id: contextId } = await deps.pool.acquire();

  try {
    const posts = await scrapeTikTokHashtag(context, url, limit, proxyUrl);

    return {
      posts,
      count: posts.length,
      hashtag: tag,
      platform: "tiktok",
    };
  } finally {
    deps.pool.release(contextId);
    await deps.fpRotator.trackAndRotate(contextId);
  }
}

// ── Patchright TikTok hashtag scraper ───────────────────────

async function scrapeTikTokHashtag(
  context: import("patchright").BrowserContext,
  url: string,
  limit: number,
  _proxyUrl: string | null,
): Promise<ScrapedHashtagPost[]> {
  const page = await context.newPage();

  try {
    // Navigate to TikTok hashtag page
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Wait for video feed container to appear
    await page
      .waitForSelector('[data-e2e="challenge-item"], [class*="DivItemContainer"]', {
        timeout: 15_000,
      })
      .catch(() => {
        // Fallback: wait a fixed time for content to render
      });

    // Let lazy-loaded content settle
    await page.waitForTimeout(3_000);

    // Scroll down a couple times to load more posts if needed
    const scrollIterations = Math.min(Math.ceil(limit / 10), 5);
    for (let i = 0; i < scrollIterations; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1_500);
    }

    // Extract post data from the page
    const posts = await page.evaluate((maxPosts: number) => {
      const results: Array<{
        url: string | null;
        description: string | null;
        creator: string | null;
        views: string | null;
        likes: string | null;
        comments: string | null;
        sound: string | null;
        thumbnail: string | null;
      }> = [];

      // TikTok video item selectors (multiple strategies for resilience)
      const videoCards = document.querySelectorAll(
        '[data-e2e="challenge-item"], [class*="DivItemContainerV2"], [class*="DivItemContainer"]',
      );

      for (const card of Array.from(videoCards).slice(0, maxPosts)) {
        // Extract video URL
        const linkEl = card.querySelector("a[href*='/video/']") as HTMLAnchorElement | null;
        const videoUrl = linkEl?.href ?? null;

        // Extract description / caption
        const descEl =
          card.querySelector('[data-e2e="challenge-item-desc"]') ??
          card.querySelector('[class*="DivDesContainer"]') ??
          card.querySelector('[class*="video-card-desc"]');
        const description = descEl?.textContent?.trim() ?? null;

        // Extract creator username
        const creatorEl =
          card.querySelector('[data-e2e="challenge-item-username"]') ??
          card.querySelector('a[href*="/@"]');
        let creator: string | null = null;
        if (creatorEl) {
          const href = (creatorEl as HTMLAnchorElement).href ?? "";
          const match = href.match(/@([^/?]+)/);
          creator = match ? match[1] : creatorEl.textContent?.trim() ?? null;
        }

        // Extract view count
        const viewEl =
          card.querySelector('[data-e2e="video-views"]') ??
          card.querySelector('[class*="DivPlayCount"]') ??
          card.querySelector("strong[data-e2e]");
        const views = viewEl?.textContent?.trim() ?? null;

        // Extract likes (if visible on card)
        const likeEl = card.querySelector('[data-e2e="video-likes"]');
        const likes = likeEl?.textContent?.trim() ?? null;

        // Extract comments count (if visible on card)
        const commentEl = card.querySelector('[data-e2e="video-comments"]');
        const comments = commentEl?.textContent?.trim() ?? null;

        // Extract sound name
        const soundEl = card.querySelector('[class*="music"], [data-e2e="video-music"]');
        const sound = soundEl?.textContent?.trim() ?? null;

        // Extract thumbnail
        const thumbEl = card.querySelector("img") as HTMLImageElement | null;
        const thumbnail = thumbEl?.src ?? null;

        results.push({
          url: videoUrl,
          description,
          creator,
          views,
          likes,
          comments,
          sound,
          thumbnail,
        });
      }

      return results;
    }, limit);

    return posts;
  } finally {
    await page.close().catch(() => {});
  }
}
