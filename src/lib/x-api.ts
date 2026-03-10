// X API v2 client — Bearer Token auth (reads) + OAuth 1.0a (writes).
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

// ── OAuth 1.0a Signing (for write operations) ───────────────

export interface XOAuthCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function buildOAuthHeader(
  method: string,
  url: string,
  params: Record<string, string>,
  creds: XOAuthCredentials,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const allParams = { ...oauthParams, ...params };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k]!)}`)
    .join("&");

  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  oauthParams["oauth_signature"] = signature;

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k]!)}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

// ── Write Operations ────────────────────────────────────────

export interface XPostTweetResponse {
  data: { id: string; text: string };
}

const TWEETS_URL = "https://api.x.com/2/tweets";

/**
 * Post a single tweet via OAuth 1.0a User Context.
 * Supports reply chaining via `replyToTweetId`.
 */
export async function postTweet(
  text: string,
  credentials: XOAuthCredentials,
  replyToTweetId?: string,
): Promise<XPostTweetResponse> {
  const body: Record<string, unknown> = { text };
  if (replyToTweetId) {
    body.reply = { in_reply_to_tweet_id: replyToTweetId };
  }

  const auth = buildOAuthHeader("POST", TWEETS_URL, {}, credentials);

  const res = await fetch(TWEETS_URL, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const resetAt = res.headers.get("x-rate-limit-reset");
    const retryAfter = resetAt
      ? Math.max(0, parseInt(resetAt, 10) - Math.floor(Date.now() / 1000))
      : 60;
    throw new Error(`X API rate limited on tweet post. Retry after ${retryAfter}s`);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`X API tweet post failed (${res.status}): ${errBody}`);
  }

  return (await res.json()) as XPostTweetResponse;
}

/**
 * Post a thread of tweets, chaining each as a reply to the previous.
 * Returns array of posted tweet IDs in order.
 */
export async function postThread(
  tweets: string[],
  credentials: XOAuthCredentials,
): Promise<string[]> {
  if (tweets.length === 0) throw new Error("Thread must have at least one tweet");

  const postedIds: string[] = [];
  let previousId: string | undefined;

  for (const text of tweets) {
    const result = await postTweet(text, credentials, previousId);
    postedIds.push(result.data.id);
    previousId = result.data.id;
  }

  return postedIds;
}

/**
 * Split long-form content into thread-sized chunks at sentence boundaries.
 * Respects the 280-char limit per tweet. Supports optional numbering mode.
 */
export function splitIntoThreadChunks(
  content: string,
  opts: { numbered?: boolean; maxChars?: number } = {},
): string[] {
  const maxChars = opts.maxChars ?? 280;

  // Split content into sentences
  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);

  const rawChunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    // If a single sentence exceeds limit, force-split it
    if (sentence.length > maxChars) {
      if (current.trim()) {
        rawChunks.push(current.trim());
        current = "";
      }
      // Word-level splitting for oversized sentences
      const words = sentence.split(/\s+/);
      let segment = "";
      for (const word of words) {
        const candidate = segment ? `${segment} ${word}` : word;
        if (candidate.length > maxChars) {
          if (segment.trim()) rawChunks.push(segment.trim());
          segment = word;
        } else {
          segment = candidate;
        }
      }
      if (segment.trim()) current = segment;
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars) {
      if (current.trim()) rawChunks.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) rawChunks.push(current.trim());

  if (!opts.numbered) return rawChunks;

  // Add numbering: "1/N) ..."
  const total = rawChunks.length;
  return rawChunks.map((chunk, i) => {
    const prefix = `${i + 1}/${total}) `;
    // If adding prefix would exceed limit, trim chunk
    if (prefix.length + chunk.length > maxChars) {
      return `${prefix}${chunk.slice(0, maxChars - prefix.length - 1)}…`;
    }
    return `${prefix}${chunk}`;
  });
}
