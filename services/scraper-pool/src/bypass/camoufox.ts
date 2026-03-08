import { firefox, type BrowserContext } from "patchright";
import type { BypassResult } from "./plain-http.js";
import { generateBrowserProfile } from "../fingerprint.js";

const CAMOUFOX_TIMEOUT = 30_000;

/**
 * Camoufox fallback — launches Firefox via Patchright (different fingerprint
 * family from Chromium). Used when Chromium-based browsers are specifically blocked.
 */
export async function fetchWithCamoufox(url: string, proxyUrl?: string): Promise<BypassResult> {
  const profile = generateBrowserProfile();

  const browser = await firefox.launch({
    headless: true,
    args: ["--no-remote"],
    proxy: proxyUrl ? { server: proxyUrl } : undefined,
  });

  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      userAgent: profile.userAgent.replace("Chrome", "Firefox").replace(/Chrome\/[\d.]+/, "Gecko/20100101 Firefox/122.0"),
      viewport: { width: profile.screenWidth, height: profile.screenHeight },
      locale: profile.locale,
      timezoneId: profile.timezone,
    });

    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: CAMOUFOX_TIMEOUT,
    });

    // Wait for any JS challenges to settle
    await page.waitForTimeout(3_000);

    // Check if we still hit a challenge page
    const html = await page.content();
    const title = await page.title();

    if (
      title.includes("Just a moment") ||
      html.includes("cf-browser-verification") ||
      html.includes("challenge-platform")
    ) {
      // Wait longer for JS challenge to resolve
      await page.waitForTimeout(8_000);
    }

    const finalHtml = await page.content();
    const browserCookies = await context.cookies(url);
    const cookies = browserCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
    }));

    return {
      success: true,
      html: finalHtml,
      cookies,
      strategy: "camoufox",
    };
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
