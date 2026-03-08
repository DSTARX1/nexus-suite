import type { BypassResult } from "./plain-http.js";

const SCRAPLING_URL = process.env.SCRAPLING_URL ?? "http://scrapling-sidecar:8000";
const SCRAPLING_TIMEOUT = 60_000;

interface ScraplingResponse {
  html: string;
  status: number;
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
}

/**
 * Scrapling sidecar client — last-resort strategy.
 * HTTP POST to the scrapling-sidecar service for scraping.
 */
export async function fetchWithScrapling(url: string): Promise<BypassResult> {
  const resp = await fetch(`${SCRAPLING_URL}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(SCRAPLING_TIMEOUT),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Scrapling sidecar error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as ScraplingResponse;

  return {
    success: true,
    html: data.html,
    cookies: data.cookies ?? [],
    strategy: "scrapling",
  };
}
