import type { BrowserContext } from "patchright";
import type { BypassResult } from "./plain-http.js";

const TURNSTILE_TIMEOUT = 30_000;
const POLL_INTERVAL = 500;

/**
 * Turnstile solver — navigates page with Patchright stealth browser,
 * finds the Turnstile challenge iframe, clicks it, and polls for the
 * cf-turnstile-response token. Native TS, no external API.
 */
export async function solveTurnstile(
  url: string,
  context: BrowserContext,
): Promise<BypassResult> {
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });

    // Wait for turnstile iframe to appear
    const iframeHandle = await page.waitForSelector(
      'iframe[src*="challenges.cloudflare.com/cdn-cgi/challenge-platform"], iframe[src*="challenges.cloudflare.com/turnstile"]',
      { timeout: 10_000 },
    );

    if (!iframeHandle) {
      throw new Error("Turnstile iframe not found");
    }

    const frame = await iframeHandle.contentFrame();
    if (!frame) {
      throw new Error("Could not access Turnstile iframe content");
    }

    // Click the challenge checkbox
    const checkbox = await frame.waitForSelector(
      'input[type="checkbox"], .cb-i, #challenge-stage',
      { timeout: 5_000 },
    ).catch(() => null);

    if (checkbox) {
      await checkbox.click();
    }

    // Poll for the turnstile response token
    const startTime = Date.now();
    while (Date.now() - startTime < TURNSTILE_TIMEOUT) {
      const token = await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>(
          'input[name="cf-turnstile-response"]',
        );
        return input?.value || null;
      });

      if (token) {
        // Challenge solved — get final page content and cookies
        await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
        const html = await page.content();
        const browserCookies = await context.cookies(url);
        const cookies = browserCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
        }));

        return {
          success: true,
          html,
          cookies,
          strategy: "turnstile",
        };
      }

      await page.waitForTimeout(POLL_INTERVAL);
    }

    throw new Error("Turnstile solve timed out");
  } finally {
    await page.close().catch(() => {});
  }
}
