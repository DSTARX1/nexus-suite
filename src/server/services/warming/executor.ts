/**
 * Warming Executor
 *
 * Launches Patchright browser with strict IP stickiness (1:1 proxy per account),
 * injects fingerprint profile, restores session state, and dispatches warming actions.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "patchright";
import { db } from "../../../lib/db";
import { fetchSecret } from "../../../lib/infisical";
import { loadSessionState, saveSessionState, type SessionState } from "./session-manager";
import { humanPause, humanScroll, humanClick, scrollFeed, watchVideo, humanType } from "./human-behavior";
import { detectVerification, handleVerification } from "./verification/detector";
import { createVerificationProvider, type VerificationCodeProvider } from "./verification/provider";
import type { WarmTask } from "./queue";

const INFISICAL_PROJECT_ID = process.env.INFISICAL_PROJECT_ID!;
const INFISICAL_ENV = process.env.INFISICAL_ENV ?? "dev";

// ── Account context loaded from DB ────────────────────────────────

interface AccountContext {
  accountId: string;
  organizationId: string;
  platform: string;
  accountLabel: string;
  proxyUrl: string | null;
  fingerprint: {
    userAgent: string;
    screenWidth: number;
    screenHeight: number;
    platform: string;
    languages: string[];
    timezone: string;
    locale: string;
  } | null;
  sessionStoragePath: string | null;
}

async function loadAccountContext(accountId: string): Promise<AccountContext> {
  const account = await db.orgPlatformToken.findUniqueOrThrow({
    where: { id: accountId },
    include: { fingerprintProfile: true, organization: true },
  });

  // Fetch proxy URL from Infisical (fetch-use-discard)
  let proxyUrl: string | null = null;
  if (account.infisicalProxyPath) {
    try {
      proxyUrl = await fetchSecret(
        INFISICAL_PROJECT_ID,
        INFISICAL_ENV,
        account.infisicalProxyPath,
        "proxyUrl",
      );
    } catch {
      console.warn(`[executor] Could not fetch proxy for ${accountId}, proceeding without`);
    }
  }

  const fp = account.fingerprintProfile;

  return {
    accountId: account.id,
    organizationId: account.organizationId,
    platform: account.platform,
    accountLabel: account.accountLabel,
    proxyUrl,
    fingerprint: fp
      ? {
          userAgent: fp.userAgent,
          screenWidth: fp.screenWidth,
          screenHeight: fp.screenHeight,
          platform: fp.platform,
          languages: fp.languages,
          timezone: fp.timezone,
          locale: fp.locale,
        }
      : null,
    sessionStoragePath: account.sessionStoragePath,
  };
}

// ── Browser Launch ────────────────────────────────────────────────

async function launchBrowser(ctx: AccountContext): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const launchOptions: Record<string, unknown> = {
    headless: true,
  };

  // Strict 1:1 proxy per account
  const contextOptions: Record<string, unknown> = {};
  if (ctx.proxyUrl) {
    const url = new URL(ctx.proxyUrl);
    contextOptions.proxy = {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  }

  // Inject fingerprint profile
  if (ctx.fingerprint) {
    contextOptions.userAgent = ctx.fingerprint.userAgent;
    contextOptions.viewport = {
      width: ctx.fingerprint.screenWidth,
      height: ctx.fingerprint.screenHeight,
    };
    contextOptions.locale = ctx.fingerprint.locale;
    contextOptions.timezoneId = ctx.fingerprint.timezone;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext(contextOptions);

  // Restore session cookies from R2
  const session = await loadSessionState(ctx.organizationId, ctx.accountId);
  if (session?.cookies?.length) {
    await context.addCookies(session.cookies);
    console.log(`[executor] Restored ${session.cookies.length} cookies for ${ctx.accountLabel}`);
  }

  const page = await context.newPage();
  return { browser, context, page };
}

// ── Session Persistence ───────────────────────────────────────────

async function persistSession(context: BrowserContext, ctx: AccountContext): Promise<void> {
  const cookies = await context.cookies();
  const state: SessionState = {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as SessionState["cookies"][0]["sameSite"],
    })),
  };

  const r2Key = await saveSessionState(ctx.organizationId, ctx.accountId, state);

  // Update DB with storage path if not set
  if (!ctx.sessionStoragePath) {
    await db.orgPlatformToken.update({
      where: { id: ctx.accountId },
      data: { sessionStoragePath: r2Key },
    });
  }
}

// ── Verification Check ────────────────────────────────────────────

let verificationProvider: VerificationCodeProvider | null = null;

async function getVerificationProvider(): Promise<VerificationCodeProvider> {
  if (!verificationProvider) {
    verificationProvider = await createVerificationProvider();
  }
  return verificationProvider;
}

async function checkAndHandleVerification(page: Page, ctx: AccountContext): Promise<boolean> {
  const detection = await detectVerification(page, ctx.platform.toLowerCase());
  if (!detection.detected) return false;

  console.log(`[executor] Verification challenge detected for ${ctx.accountLabel}`);
  const provider = await getVerificationProvider();
  return handleVerification(page, provider, ctx.accountLabel, ctx.platform.toLowerCase());
}

// ── Action Handlers ───────────────────────────────────────────────

type ActionFn = (page: Page, ctx: AccountContext, params: Record<string, unknown>) => Promise<void>;

const actions: Record<string, ActionFn> = {
  "scroll-feed": async (page, ctx) => {
    const platformUrls: Record<string, string> = {
      TIKTOK: "https://www.tiktok.com/foryou",
      INSTAGRAM: "https://www.instagram.com/",
    };
    const url = platformUrls[ctx.platform] ?? "https://www.tiktok.com/foryou";
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await humanPause(2000, 4000);
    await checkAndHandleVerification(page, ctx);

    // Scroll feed for 2-5 minutes
    const durationMs = (2 + Math.random() * 3) * 60_000;
    await scrollFeed(page, durationMs);
  },

  "watch-video": async (page, ctx) => {
    const platformUrls: Record<string, string> = {
      TIKTOK: "https://www.tiktok.com/foryou",
      INSTAGRAM: "https://www.instagram.com/reels/",
    };
    const url = platformUrls[ctx.platform] ?? "https://www.tiktok.com/foryou";
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await humanPause(2000, 4000);
    await checkAndHandleVerification(page, ctx);

    // Watch 30s-3min per video
    await watchVideo(page, 30, 180);
  },

  "like-post": async (page, ctx) => {
    // Navigate to feed, scroll to find a post, like it
    const platformUrls: Record<string, string> = {
      TIKTOK: "https://www.tiktok.com/foryou",
      INSTAGRAM: "https://www.instagram.com/",
    };
    await page.goto(platformUrls[ctx.platform] ?? "https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded" });
    await humanPause(2000, 4000);
    await checkAndHandleVerification(page, ctx);

    // Scroll to find content
    await humanScroll(page, 300 + Math.random() * 500);
    await humanPause(1000, 3000);

    // Platform-specific like selectors
    const likeSelectors: Record<string, string> = {
      TIKTOK: '[data-e2e="like-icon"]',
      INSTAGRAM: 'svg[aria-label="Like"]',
    };
    const sel = likeSelectors[ctx.platform] ?? '[data-e2e="like-icon"]';
    try {
      await humanClick(page, sel);
    } catch {
      console.warn(`[executor] Could not find like button for ${ctx.platform}`);
    }
  },

  "follow-account": async (page, ctx) => {
    const platformUrls: Record<string, string> = {
      TIKTOK: "https://www.tiktok.com/foryou",
      INSTAGRAM: "https://www.instagram.com/explore/",
    };
    await page.goto(platformUrls[ctx.platform] ?? "https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded" });
    await humanPause(2000, 4000);
    await checkAndHandleVerification(page, ctx);

    await humanScroll(page, 400 + Math.random() * 600);
    await humanPause(1000, 2000);

    const followSelectors: Record<string, string> = {
      TIKTOK: '[data-e2e="follow-button"]',
      INSTAGRAM: 'button:has-text("Follow")',
    };
    const sel = followSelectors[ctx.platform] ?? 'button:has-text("Follow")';
    try {
      await humanClick(page, sel);
    } catch {
      console.warn(`[executor] Could not find follow button for ${ctx.platform}`);
    }
  },

  "post-comment": async (page, ctx, params) => {
    const comment = (params.comment as string) ?? "Great content! 🔥";

    const platformUrls: Record<string, string> = {
      TIKTOK: "https://www.tiktok.com/foryou",
      INSTAGRAM: "https://www.instagram.com/",
    };
    await page.goto(platformUrls[ctx.platform] ?? "https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded" });
    await humanPause(3000, 5000);
    await checkAndHandleVerification(page, ctx);

    await humanScroll(page, 300 + Math.random() * 400);
    await humanPause(1000, 3000);

    // Open comment section
    const commentSelectors: Record<string, string> = {
      TIKTOK: '[data-e2e="comment-icon"]',
      INSTAGRAM: 'svg[aria-label="Comment"]',
    };
    const commentSel = commentSelectors[ctx.platform] ?? '[data-e2e="comment-icon"]';
    try {
      await humanClick(page, commentSel);
      await humanPause(1000, 2000);

      const inputSelectors: Record<string, string> = {
        TIKTOK: '[data-e2e="comment-input"]',
        INSTAGRAM: 'textarea[aria-label="Add a comment…"]',
      };
      const inputSel = inputSelectors[ctx.platform] ?? 'textarea';
      await humanType(page, inputSel, comment);
      await humanPause(500, 1500);

      // Submit
      const submitSelectors: Record<string, string> = {
        TIKTOK: '[data-e2e="comment-post"]',
        INSTAGRAM: 'button:has-text("Post")',
      };
      const submitSel = submitSelectors[ctx.platform] ?? 'button[type="submit"]';
      await humanClick(page, submitSel);
    } catch {
      console.warn(`[executor] Could not post comment on ${ctx.platform}`);
    }
  },

  "post-video": async (page, ctx) => {
    // Navigate to upload page — actual upload is out of scope for warming
    // This is a placeholder that navigates to the creator page
    const creatorUrls: Record<string, string> = {
      TIKTOK: "https://www.tiktok.com/creator#/upload",
      INSTAGRAM: "https://www.instagram.com/",
    };
    await page.goto(creatorUrls[ctx.platform] ?? "https://www.tiktok.com/creator#/upload", { waitUntil: "domcontentloaded" });
    await humanPause(3000, 5000);
    await checkAndHandleVerification(page, ctx);

    console.log(`[executor] Post-video: navigated to creator page for ${ctx.accountLabel}. Actual upload requires media pipeline.`);
  },
};

// ── Main Executor ─────────────────────────────────────────────────

/**
 * Execute a warming task: launch browser, run action, persist session, close.
 */
export async function executeWarmTask(task: WarmTask): Promise<void> {
  const ctx = await loadAccountContext(task.accountId);
  console.log(`[executor] Starting ${task.action} for ${ctx.accountLabel} (phase ${task.phase})`);

  const { browser, context, page } = await launchBrowser(ctx);

  try {
    const actionFn = actions[task.action];
    if (!actionFn) {
      throw new Error(`Unknown warming action: ${task.action}`);
    }

    await actionFn(page, ctx, task.params ?? {});

    // Persist session state after every action
    await persistSession(context, ctx);
    console.log(`[executor] Completed ${task.action} for ${ctx.accountLabel}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** Dispose global resources (verification provider) */
export async function disposeExecutor(): Promise<void> {
  if (verificationProvider) {
    await verificationProvider.dispose();
    verificationProvider = null;
  }
}
