import { Redis } from "ioredis";
import { db } from "@/lib/db";
import { fetchSecret } from "@/lib/infisical";
import { recordSuccess, recordFailure } from "./circuit-breaker";
import type { Platform, AccountType } from "@prisma/client";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0");

const INFISICAL_PROJECT_ID = process.env.INFISICAL_PROJECT_ID ?? "";
const INFISICAL_ENV = process.env.INFISICAL_ENV ?? "production";

// ── Types ─────────────────────────────────────────────────────

interface PostResult {
  success: boolean;
  externalPostId?: string;
  errorMessage?: string;
}

interface AccountData {
  id: string;
  accountType: AccountType;
  platform: Platform;
  infisicalSecretPath: string;
  infisicalProxyPath: string | null;
  fingerprintProfileId: string | null;
  sessionStoragePath: string | null;
  fingerprintProfile: {
    userAgent: string;
    screenWidth: number;
    screenHeight: number;
    timezone: string;
    locale: string;
  } | null;
}

interface VariationData {
  id: string;
  r2StorageKey: string | null;
  caption: string | null;
}

// ── Main entry ────────────────────────────────────────────────

export async function postContent(
  orgId: string,
  accountId: string,
  variationId: string,
  platform: Platform,
  postRecordId: string,
): Promise<PostResult> {
  // Mark as POSTING
  await db.postRecord.update({
    where: { id: postRecordId },
    data: { status: "POSTING" },
  });

  const account = await db.orgPlatformToken.findUnique({
    where: { id: accountId },
    include: {
      fingerprintProfile: {
        select: {
          userAgent: true,
          screenWidth: true,
          screenHeight: true,
          timezone: true,
          locale: true,
        },
      },
    },
  });

  if (!account) {
    const result: PostResult = { success: false, errorMessage: "Account not found" };
    await finalizePost(postRecordId, accountId, result);
    return result;
  }

  const variation = await db.videoVariation.findUnique({
    where: { id: variationId },
    select: { id: true, r2StorageKey: true, caption: true },
  });

  if (!variation) {
    const result: PostResult = { success: false, errorMessage: "Variation not found" };
    await finalizePost(postRecordId, accountId, result);
    return result;
  }

  // Route by account type
  let result: PostResult;
  try {
    if (account.accountType === "PRIMARY") {
      result = await postViaApi(account, variation, platform);
    } else {
      result = await postViaBrowser(account, variation, platform);
    }
  } catch (err) {
    result = {
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  await finalizePost(postRecordId, accountId, result);
  return result;
}

// ── Finalize ──────────────────────────────────────────────────

async function finalizePost(
  postRecordId: string,
  accountId: string,
  result: PostResult,
): Promise<void> {
  await db.postRecord.update({
    where: { id: postRecordId },
    data: {
      status: result.success ? "SUCCESS" : "FAILED",
      postedAt: result.success ? new Date() : undefined,
      externalPostId: result.externalPostId ?? undefined,
      errorMessage: result.errorMessage ?? undefined,
    },
  });

  if (result.success) {
    await recordSuccess(accountId);
  } else {
    await recordFailure(accountId);
  }

  // Emit SSE event via Redis pub/sub
  await redis.publish(
    "post:events",
    JSON.stringify({
      type: result.success ? "post:success" : "post:failure",
      postRecordId,
      accountId,
      externalPostId: result.externalPostId,
      errorMessage: result.errorMessage,
      timestamp: new Date().toISOString(),
    }),
  );
}

// ── API Posting (PRIMARY accounts) ────────────────────────────

async function postViaApi(
  account: AccountData,
  variation: VariationData,
  platform: Platform,
): Promise<PostResult> {
  // Fetch OAuth tokens from Infisical (fetch-use-discard)
  const _accessToken = await fetchSecret(
    INFISICAL_PROJECT_ID,
    INFISICAL_ENV,
    account.infisicalSecretPath,
    "access_token",
  );

  switch (platform) {
    case "YOUTUBE":
      return postYouTubeApi(variation);
    case "TIKTOK":
      return postTikTokApi(variation);
    case "INSTAGRAM":
      return postInstagramApi(variation);
    case "FACEBOOK":
      return postFacebookApi(variation);
    case "X":
      return postXApi(variation);
    case "LINKEDIN":
      return postLinkedInApi(variation);
    default:
      return { success: false, errorMessage: `Unsupported platform: ${platform}` };
  }
}

// Platform API stubs — each returns PostResult
// These will be replaced with real API calls in later phases

async function postYouTubeApi(variation: VariationData): Promise<PostResult> {
  // TODO: YouTube Data API v3 — videos.insert with resumable upload
  void variation;
  return { success: false, errorMessage: "YouTube API posting not yet implemented" };
}

async function postTikTokApi(variation: VariationData): Promise<PostResult> {
  // TODO: TikTok Content Posting API — /v2/post/publish/video/init
  void variation;
  return { success: false, errorMessage: "TikTok API posting not yet implemented" };
}

async function postInstagramApi(variation: VariationData): Promise<PostResult> {
  // TODO: Meta Graph API — /me/media + /me/media_publish (Reels)
  void variation;
  return { success: false, errorMessage: "Instagram API posting not yet implemented" };
}

async function postFacebookApi(variation: VariationData): Promise<PostResult> {
  // TODO: Meta Graph API — /{page-id}/videos
  void variation;
  return { success: false, errorMessage: "Facebook API posting not yet implemented" };
}

async function postXApi(variation: VariationData): Promise<PostResult> {
  // TODO: X API v2 — POST /2/tweets with media upload
  void variation;
  return { success: false, errorMessage: "X API posting not yet implemented" };
}

async function postLinkedInApi(variation: VariationData): Promise<PostResult> {
  // TODO: LinkedIn Marketing API — /ugcPosts with video upload
  void variation;
  return { success: false, errorMessage: "LinkedIn API posting not yet implemented" };
}

// ── Browser Posting (SECONDARY accounts) ──────────────────────

async function postViaBrowser(
  account: AccountData,
  variation: VariationData,
  platform: Platform,
): Promise<PostResult> {
  // Load browser profile fingerprint
  if (!account.fingerprintProfile) {
    return { success: false, errorMessage: "No fingerprint profile configured" };
  }

  // Fetch proxy URL from Infisical if configured
  let _proxyUrl: string | undefined;
  if (account.infisicalProxyPath) {
    _proxyUrl = await fetchSecret(
      INFISICAL_PROJECT_ID,
      INFISICAL_ENV,
      account.infisicalProxyPath,
      "proxy_url",
    );
  }

  // Fetch session storage path for persistent session
  const _sessionPath = account.sessionStoragePath;

  // TODO: Patchright browser automation
  // 1. Launch browser with fingerprint profile + proxy
  // 2. Load persistent session from R2 (sessionStoragePath)
  // 3. Navigate to platform upload page
  // 4. Fill form with variation.caption
  // 5. Upload file from R2 (variation.r2StorageKey)
  // 6. Wait for confirmation
  // 7. Save updated session back to R2

  void platform;
  void variation;

  return { success: false, errorMessage: "Browser posting not yet implemented" };
}
