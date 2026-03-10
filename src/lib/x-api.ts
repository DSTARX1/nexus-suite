// X API v2 read client — Bearer Token auth (App-Only).
// Rate-limited to respect 10k reads/month free tier.
// Results cached in Redis for 15 minutes.

import crypto from "node:crypto";
import { redis } from "@/lib/redis.js";

// ── Constants ────────────────────────────────────────────────

const X_API_BASE = "https://api.twitter.com/2";
const CACHE_TTL_SECONDS = 15 * 60; // 15 minutes
const MONTHLY_READ_LIMIT = 10_000;
const RATE_LIMIT_KEY = "x:rate:monthly_reads";

// ── Types ────────────────────────────────────────────────────

export interface XTweetPublicMetrics {
  retweet_count: number;
  reply_count: number;
  like_count: number;
  quote_count: number;
  impression_count?: number;
}

export interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: XTweetPublicMetrics;
}

export interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
  description?: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
    listed_count: number;
  };
}

export interface XSearchResponse {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { result_count: number; next_token?: string };
}

export interface XUserResponse {
  data?: XUser;
}

export interface XTimelineResponse {
  data?: XTweet[];
  meta?: { result_count: number; next_token?: string };
}

export interface XMentionsResponse {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { result_count: number; next_token?: string };
}

// ── Rate Limiting ────────────────────────────────────────────

async function checkAndIncrementRate(count: number): Promise<void> {
  const current = await redis.get(RATE_LIMIT_KEY);
  const used = current ? parseInt(current, 10) : 0;

  if (used + count > MONTHLY_READ_LIMIT) {
    throw new Error(
      `X API monthly read limit would be exceeded (${used}/${MONTHLY_READ_LIMIT} used, requesting ${count})`,
    );
  }

  // Increment and set expiry to end of current month
  const pipeline = redis.pipeline();
  pipeline.incrby(RATE_LIMIT_KEY, count);

  // Set expiry to end of current month if key is new
  if (!current) {
    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const ttl = Math.ceil((endOfMonth.getTime() - now.getTime()) / 1000);
    pipeline.expire(RATE_LIMIT_KEY, ttl);
  }

  await pipeline.exec();
}

export async function getRateUsage(): Promise<{ used: number; limit: number }> {
  const current = await redis.get(RATE_LIMIT_KEY);
  return { used: current ? parseInt(current, 10) : 0, limit: MONTHLY_READ_LIMIT };
}

// ── Cache ────────────────────────────────────────────────────

function cacheKey(prefix: string, input: string): string {
  const hash = crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `x:${prefix}:${hash}`;
}

async function getFromCache<T>(key: string): Promise<T | null> {
  const cached = await redis.get(key);
  if (!cached) return null;
  return JSON.parse(cached) as T;
}

async function setCache(key: string, data: unknown): Promise<void> {
  await redis.set(key, JSON.stringify(data), "EX", CACHE_TTL_SECONDS);
}

// ── Core Fetch ───────────────────────────────────────────────

async function xApiFetch<T>(
  bearerToken: string,
  path: string,
  readCount: number,
): Promise<T> {
  await checkAndIncrementRate(readCount);

  const res = await fetch(`${X_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });

  if (res.status === 429) {
    const resetAt = res.headers.get("x-rate-limit-reset");
    const retryAfter = resetAt
      ? Math.max(0, parseInt(resetAt, 10) - Math.floor(Date.now() / 1000))
      : 60;
    throw new Error(`X API rate limited. Retry after ${retryAfter}s`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`X API error ${res.status}: ${body}`);
  }

  return (await res.json()) as T;
}

// ── Public Methods ───────────────────────────────────────────

/**
 * Search recent tweets (last 7 days) using X API v2.
 * Cached for 15 minutes per unique query+maxResults combo.
 */
export async function searchRecentTweets(
  bearerToken: string,
  query: string,
  maxResults = 10,
): Promise<XSearchResponse> {
  const key = cacheKey("search", `${query}|${maxResults}`);
  const cached = await getFromCache<XSearchResponse>(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    query,
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    "tweet.fields": "author_id,created_at,public_metrics",
    expansions: "author_id",
    "user.fields": "username,name,profile_image_url",
  });

  const result = await xApiFetch<XSearchResponse>(
    bearerToken,
    `/tweets/search/recent?${params}`,
    maxResults,
  );

  await setCache(key, result);
  return result;
}

/**
 * Get a user's recent tweets.
 * Cached for 15 minutes per userId+maxResults combo.
 */
export async function getUserTimeline(
  bearerToken: string,
  userId: string,
  maxResults = 10,
): Promise<XTimelineResponse> {
  const key = cacheKey("timeline", `${userId}|${maxResults}`);
  const cached = await getFromCache<XTimelineResponse>(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    "tweet.fields": "created_at,public_metrics",
    max_results: String(Math.min(Math.max(maxResults, 5), 100)),
  });

  const result = await xApiFetch<XTimelineResponse>(
    bearerToken,
    `/users/${userId}/tweets?${params}`,
    maxResults,
  );

  await setCache(key, result);
  return result;
}

/**
 * Look up a user by username.
 * Cached for 15 minutes.
 */
export async function getUserByUsername(
  bearerToken: string,
  username: string,
): Promise<XUserResponse> {
  const key = cacheKey("user", username);
  const cached = await getFromCache<XUserResponse>(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    "user.fields": "created_at,description,public_metrics,verified,profile_image_url",
  });

  const result = await xApiFetch<XUserResponse>(
    bearerToken,
    `/users/by/username/${encodeURIComponent(username)}?${params}`,
    1,
  );

  await setCache(key, result);
  return result;
}

/**
 * Get mentions for a user.
 * Cached for 15 minutes.
 */
export async function getUserMentions(
  bearerToken: string,
  userId: string,
  maxResults = 10,
): Promise<XMentionsResponse> {
  const key = cacheKey("mentions", `${userId}|${maxResults}`);
  const cached = await getFromCache<XMentionsResponse>(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    "tweet.fields": "author_id,created_at,public_metrics",
    expansions: "author_id",
    "user.fields": "username,name,profile_image_url",
    max_results: String(Math.min(Math.max(maxResults, 5), 100)),
  });

  const result = await xApiFetch<XMentionsResponse>(
    bearerToken,
    `/users/${userId}/mentions?${params}`,
    maxResults,
  );

  await setCache(key, result);
  return result;
}
