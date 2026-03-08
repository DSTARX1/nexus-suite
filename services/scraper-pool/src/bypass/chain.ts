import type { BrowserContext } from "patchright";
import type { Redis } from "ioredis";
import { CookieCache } from "./cookie-cache.js";
import { plainHttpFetch, ChallengeDetectedError, type BypassResult } from "./plain-http.js";
import { solveTurnstile } from "./turnstile.js";
import { solveRecaptcha } from "./recaptcha.js";
import { fetchWithCamoufox } from "./camoufox.js";
import { fetchWithScrapling } from "./scrapling-client.js";

export interface ChainOptions {
  url: string;
  context: BrowserContext;
  redis: Redis;
  proxyUrl?: string;
  onStrategy?: (strategy: string) => void;
}

/**
 * Bypass decision chain — tries strategies in escalating order:
 * 1. Plain HTTP (with cached CF cookies if available)
 * 2. Patchright stealth (Turnstile / reCAPTCHA solvers)
 * 3. Camoufox (Firefox fingerprint family)
 * 4. Scrapling sidecar (last resort)
 *
 * On successful challenge solve, caches cookies for future request mirroring.
 */
export async function runBypassChain(opts: ChainOptions): Promise<BypassResult> {
  const { url, context, redis, proxyUrl, onStrategy } = opts;
  const cookieCache = new CookieCache(redis);
  const domain = new URL(url).hostname;

  // Strategy 1: Plain HTTP with cookie cache
  onStrategy?.("plain-http");
  try {
    return await plainHttpFetch(url, cookieCache);
  } catch (err) {
    if (!(err instanceof ChallengeDetectedError)) throw err;
    console.log(`[BypassChain] challenge detected (${err.type}) for ${domain}, escalating`);
  }

  // Strategy 2: Patchright stealth — route by challenge type
  onStrategy?.("patchright-stealth");
  try {
    const result = await solvWithPatchright(url, context, cookieCache, domain, onStrategy);
    return result;
  } catch (err) {
    console.warn(`[BypassChain] Patchright stealth failed for ${domain}:`, (err as Error).message);
  }

  // Strategy 3: Camoufox (Firefox)
  onStrategy?.("camoufox");
  try {
    const result = await fetchWithCamoufox(url, proxyUrl);
    if (result.success && result.cookies.length > 0) {
      await cookieCache.set(domain, {
        cookies: result.cookies,
        userAgent: "",
      });
    }
    return result;
  } catch (err) {
    console.warn(`[BypassChain] Camoufox failed for ${domain}:`, (err as Error).message);
  }

  // Strategy 4: Scrapling sidecar (last resort)
  onStrategy?.("scrapling");
  return await fetchWithScrapling(url);
}

async function solvWithPatchright(
  url: string,
  context: BrowserContext,
  cookieCache: CookieCache,
  domain: string,
  onStrategy?: (strategy: string) => void,
): Promise<BypassResult> {
  // First, try a basic Patchright navigation (stealth browser may bypass JS challenges)
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(3_000);

    const html = await page.content();

    // Check if challenge is still present
    const { detectChallenge } = await import("./plain-http.js");
    const challenge = detectChallenge(html);

    if (!challenge) {
      // Stealth browser bypassed it directly
      const browserCookies = await context.cookies(url);
      const cookies = browserCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
      }));

      if (cookies.length > 0) {
        await cookieCache.set(domain, { cookies, userAgent: "" });
      }

      return { success: true, html, cookies, strategy: "patchright-stealth" };
    }

    await page.close().catch(() => {});

    // Route to specific solver based on challenge type
    if (challenge === "turnstile") {
      onStrategy?.("turnstile");
      const result = await solveTurnstile(url, context);
      if (result.success && result.cookies.length > 0) {
        await cookieCache.set(domain, { cookies: result.cookies, userAgent: "" });
      }
      return result;
    }

    if (challenge === "recaptcha") {
      onStrategy?.("recaptcha");
      const result = await solveRecaptcha(url, context);
      if (result.success && result.cookies.length > 0) {
        await cookieCache.set(domain, { cookies: result.cookies, userAgent: "" });
      }
      return result;
    }

    // Generic CF challenge — wait for JS challenge to auto-resolve
    const page2 = await context.newPage();
    try {
      await page2.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page2.waitForTimeout(8_000);
      const finalHtml = await page2.content();
      const browserCookies = await context.cookies(url);
      const cookies = browserCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
      }));

      if (cookies.length > 0) {
        await cookieCache.set(domain, { cookies, userAgent: "" });
      }

      return { success: true, html: finalHtml, cookies, strategy: "patchright-cf-wait" };
    } finally {
      await page2.close().catch(() => {});
    }
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}
