import type PgBoss from "pg-boss";
import { db } from "@/lib/db";
import { fetchSecret } from "@/lib/infisical";
import type { AnalyticsSyncJob } from "../types.js";

export async function handleAnalyticsSync(
  job: PgBoss.Job<AnalyticsSyncJob>,
): Promise<void> {
  const { platformId, dateRange, organizationId } = job.data;

  console.log(
    `[analytics-sync] syncing platform=${platformId} org=${organizationId} range=${dateRange.from}..${dateRange.to}`,
  );

  // Resolve platform account for API access
  const account = await db.orgPlatformToken.findFirst({
    where: { id: platformId, organizationId },
    select: { id: true, platform: true, infisicalSecretPath: true },
  });

  if (!account) {
    console.error(`[analytics-sync] account not found: ${platformId}`);
    return;
  }

  // Fetch-use-discard: resolve credentials at runtime
  const accessToken = await fetchSecret(
    process.env.INFISICAL_PROJECT_ID!,
    process.env.INFISICAL_ENV ?? "prod",
    account.infisicalSecretPath,
    "accessToken",
  );

  // Platform-specific analytics fetch
  // TODO: expand per-platform once AnalyticsMetric model exists in schema
  const from = encodeURIComponent(dateRange.from);
  const to = encodeURIComponent(dateRange.to);

  const res = await fetch(
    getAnalyticsEndpoint(account.platform, accessToken, from, to),
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) {
    console.error(
      `[analytics-sync] API error platform=${account.platform} status=${res.status}`,
    );
    throw new Error(`Analytics API returned ${res.status}`);
  }

  const metrics = await res.json();

  // No AnalyticsMetric model yet — log metrics until schema migration lands
  console.log(
    `[analytics-sync] fetched ${Array.isArray(metrics) ? metrics.length : 1} metric(s) for platform=${account.platform} job=${job.id}`,
  );
}

/** Placeholder endpoint mapper — real URLs added per-platform */
function getAnalyticsEndpoint(
  platform: string,
  _token: string,
  from: string,
  to: string,
): string {
  const endpoints: Record<string, string> = {
    YOUTUBE: `https://youtubeanalytics.googleapis.com/v2/reports?startDate=${from}&endDate=${to}&metrics=views,likes,shares`,
    TIKTOK: `https://open.tiktokapis.com/v2/research/video/query/?start_date=${from}&end_date=${to}`,
    INSTAGRAM: `https://graph.instagram.com/me/insights?since=${from}&until=${to}&metric=impressions,reach`,
  };
  return endpoints[platform] ?? `https://api.example.com/analytics?from=${from}&to=${to}`;
}
