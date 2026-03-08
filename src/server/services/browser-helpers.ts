/**
 * Shared browser helpers — extracted from warming/executor.ts
 *
 * Provides account context loading, Patchright browser launch with
 * fingerprint+proxy injection, and session persistence via R2.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "patchright";
import { db } from "../../lib/db";
import { fetchSecret } from "../../lib/infisical";
import { loadSessionState, saveSessionState, type SessionState } from "./warming/session-manager";

const INFISICAL_PROJECT_ID = process.env.INFISICAL_PROJECT_ID!;
const INFISICAL_ENV = process.env.INFISICAL_ENV ?? "dev";

// ── Account context loaded from DB ────────────────────────────────

export interface AccountContext {
  accountId: string;
  organizationId: string;
  platform: string;
  accountLabel: string;
  email: string | null;
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

export async function loadAccountContext(accountId: string): Promise<AccountContext> {
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
      console.warn(`[browser-helpers] Could not fetch proxy for ${accountId}, proceeding without`);
    }
  }

  const fp = account.fingerprintProfile;

  return {
    accountId: account.id,
    organizationId: account.organizationId,
    platform: account.platform,
    accountLabel: account.accountLabel,
    email: (account as Record<string, unknown>).email as string | null ?? null,
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

export async function launchBrowser(ctx: AccountContext): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
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
    console.log(`[browser-helpers] Restored ${session.cookies.length} cookies for ${ctx.accountLabel}`);
  }

  const page = await context.newPage();
  return { browser, context, page };
}

// ── Session Persistence ───────────────────────────────────────────

export async function persistSession(context: BrowserContext, ctx: AccountContext): Promise<void> {
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
