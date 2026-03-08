import { fetchSecret } from "@/lib/infisical";
import { getSignedUrl } from "@/server/services/r2-storage";
import { randomUUID } from "crypto";

const INFISICAL_PROJECT_ID = process.env.INFISICAL_PROJECT_ID ?? "";
const INFISICAL_ENV = process.env.INFISICAL_ENV ?? "production";

// ── Types ─────────────────────────────────────────────────────

export interface MetaAuthConfig {
  accessToken: string;
  pageId: string;
  igUserId: string;
}

export interface PostResult {
  success: boolean;
  externalPostId?: string;
  errorMessage?: string;
}

// ── Auth ──────────────────────────────────────────────────────

export async function getMetaAuth(
  infisicalSecretPath: string,
): Promise<MetaAuthConfig> {
  const [accessToken, pageId, igUserId] = await Promise.all([
    fetchSecret(INFISICAL_PROJECT_ID, INFISICAL_ENV, infisicalSecretPath, "access_token"),
    fetchSecret(INFISICAL_PROJECT_ID, INFISICAL_ENV, infisicalSecretPath, "page_id"),
    fetchSecret(INFISICAL_PROJECT_ID, INFISICAL_ENV, infisicalSecretPath, "ig_user_id"),
  ]);

  return { accessToken, pageId, igUserId };
}

// ── Helpers ───────────────────────────────────────────────────

export function isMockMode(): boolean {
  return process.env.MOCK_PLATFORM_APIS === "true";
}

export async function getVideoUrl(r2StorageKey: string): Promise<string> {
  return getSignedUrl(r2StorageKey, 3600);
}

// ── Mock Responses ────────────────────────────────────────────

export function mockPostResult(): PostResult {
  return {
    success: true,
    externalPostId: `mock_${randomUUID()}`,
  };
}
