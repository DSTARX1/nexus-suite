/**
 * Warming Executor
 *
 * Launches Patchright browser with strict IP stickiness (1:1 proxy per account),
 * injects fingerprint profile, restores session state, and dispatches warming actions.
 */

import type { Page } from "patchright";
import { type AccountContext, loadAccountContext, launchBrowser, persistSession } from "../browser-helpers";
import { humanPause, humanScroll, humanClick, scrollFeed, watchVideo, humanType } from "./human-behavior";
import { detectVerification, handleVerification, type VerificationType } from "./verification/detector";
import { createVerificationProvider, type VerificationCodeProvider } from "./verification/provider";
import { recordVerification } from "./health-tracker";
import type { WarmTask } from "./queue";

// ── Verification Providers (per-type) ─────────────────────────────

const providers: Record<string, VerificationCodeProvider> = {};

async function getProviderForType(vType: VerificationType): Promise<VerificationCodeProvider> {
  const key = vType === "email" ? "imap" : "sms";
  if (!providers[key]) {
    providers[key] = await createVerificationProvider(key === "imap" ? "imap" : undefined);
  }
  return providers[key];
}

async function checkAndHandleVerification(page: Page, ctx: AccountContext): Promise<boolean> {
  const detection = await detectVerification(page, ctx.platform.toLowerCase());
  if (!detection.detected) return false;

  const vType = detection.verificationType ?? "unknown";
  console.log(`[executor] Verification challenge detected for ${ctx.accountLabel} (type: ${vType})`);

  // Pick provider + identifier based on verification type
  const resolvedType: VerificationType = vType === "unknown" ? (ctx.email ? "email" : "sms") : vType;
  const provider = await getProviderForType(resolvedType);
  const identifier = resolvedType === "email" ? (ctx.email ?? ctx.accountLabel) : ctx.platform.toLowerCase();

  const success = await handleVerification(page, provider, identifier, ctx.platform.toLowerCase());
  await recordVerification(ctx.accountId, success);
  return success;
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

    // Scroll feed for 2-5 minutes, re-check verification every ~30s
    const durationMs = (2 + Math.random() * 3) * 60_000;
    await scrollFeed(page, durationMs, () => checkAndHandleVerification(page, ctx).then(() => {}));
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

    // Watch 30s-3min per video, re-check verification every ~30s
    await watchVideo(page, 30, 180, () => checkAndHandleVerification(page, ctx).then(() => {}));
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

/** Dispose global resources (verification providers) */
export async function disposeExecutor(): Promise<void> {
  for (const [key, provider] of Object.entries(providers)) {
    await provider.dispose();
    delete providers[key];
  }
}
