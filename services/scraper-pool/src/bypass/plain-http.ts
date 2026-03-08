import type { CookieCache } from "./cookie-cache.js";

export interface BypassResult {
  success: boolean;
  html: string;
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  strategy: string;
}

const CF_CHALLENGE_MARKERS = [
  "cf-browser-verification",
  "cf_chl_opt",
  "challenge-platform",
  "Just a moment...",
  "_cf_chl_tk",
  "Checking your browser",
  "Attention Required! | Cloudflare",
];

const RECAPTCHA_MARKERS = [
  "g-recaptcha",
  "recaptcha/api.js",
  "recaptcha-token",
];

const TURNSTILE_MARKERS = [
  "cf-turnstile",
  "challenges.cloudflare.com/turnstile",
];

export function detectChallenge(html: string): "cf" | "recaptcha" | "turnstile" | null {
  for (const marker of TURNSTILE_MARKERS) {
    if (html.includes(marker)) return "turnstile";
  }
  for (const marker of RECAPTCHA_MARKERS) {
    if (html.includes(marker)) return "recaptcha";
  }
  for (const marker of CF_CHALLENGE_MARKERS) {
    if (html.includes(marker)) return "cf";
  }
  return null;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.91 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.58 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.69 Safari/537.36",
];

/**
 * Plain HTTP fetch with rotating UA.
 * Checks cookie cache first — if cached CF cookies exist, injects them (request mirroring).
 */
export async function plainHttpFetch(
  url: string,
  cookieCache: CookieCache,
): Promise<BypassResult> {
  const domain = new URL(url).hostname;
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  // Check cookie cache for pre-solved CF cookies
  const cached = await cookieCache.get(domain);
  const headers: Record<string, string> = {
    "User-Agent": cached?.userAgent ?? ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
  };

  if (cached) {
    headers["Cookie"] = cached.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  const resp = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  const html = await resp.text();
  const challenge = detectChallenge(html);

  if (challenge || resp.status === 403 || resp.status === 503) {
    throw new ChallengeDetectedError(challenge ?? "cf", html);
  }

  return {
    success: true,
    html,
    cookies: [],
    strategy: "plain-http",
  };
}

export class ChallengeDetectedError extends Error {
  type: string;
  html: string;

  constructor(type: string, html: string) {
    super(`Challenge detected: ${type}`);
    this.name = "ChallengeDetectedError";
    this.type = type;
    this.html = html;
  }
}
