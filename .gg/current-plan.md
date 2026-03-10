## Plan: saraiknowsball Client Onboarding — Issues #83-#93

Overview: Wire all 11 open issues for the first client (saraiknowsball) in logical dependency order. Issues span data seeding (#83), new workers (#84), platform API integrations (#85-#88), content pipeline (#89), env config (#90), platform posting (#91), Stripe verification (#92), and analytics dashboard (#93). Decomposed into 8 chunks.

Packages: `rss-parser` (for #84 RSS worker)
Wiring: Add `rss` router to `src/server/api/root.ts`, add `analytics` router to `src/server/api/root.ts`, add Analytics nav link to sidebar

---

### Research Findings

#### RSS Parsing (Issue #84)
**Pattern** (from freeCodeCamp/mobile, Crossbell-Box/xLog, n8n-io):
```typescript
import Parser from "rss-parser";
const parser = new Parser();
const feed = await parser.parseURL(url);
// feed.items[].title, feed.items[].link, feed.items[].contentSnippet, feed.items[].isoDate
```
Simple, synchronous parse. No config needed. `parseURL` returns typed `Output<Item>`.

#### X API v2 — Bearer Token Search (Issue #85)
**Pattern** (from waynesutton/clawsync, CrowdDotDev/crowd.dev):
```typescript
// Search recent tweets
const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${maxResults}&tweet.fields=author_id,created_at,public_metrics&expansions=author_id&user.fields=username,name,profile_image_url`;
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${bearerToken}` },
});

// Get user timeline
const url = `https://api.twitter.com/2/users/${userId}/tweets?tweet.fields=created_at,public_metrics&max_results=10`;

// Get user by username
const url = `https://api.twitter.com/2/users/by/username/${username}?user.fields=created_at,description,public_metrics,verified,profile_image_url`;

// Fetch mentions
const url = `https://api.twitter.com/2/users/${userId}/mentions?tweet.fields=author_id,created_at,public_metrics&expansions=author_id&user.fields=username,name,profile_image_url`;
```
Free tier: 10,000 tweet reads/month. Rate limit headers: `x-rate-limit-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset`.

#### X API v2 — Thread Posting (Issue #88)
**Pattern** (from Infatoshi/x-mcp, waynesutton/clawsync):
```typescript
// Post tweet with reply (for thread chaining)
const body: Record<string, unknown> = { text };
if (replyToTweetId) {
  body.reply = { in_reply_to_tweet_id: replyToTweetId };
}
// POST https://api.x.com/2/tweets with OAuth 1.0a
```
Thread = post first tweet, get its ID, then post each subsequent tweet as a reply to the previous one. Existing `src/server/services/platform-apis/x.ts` already has full OAuth 1.0a signing.

#### Stripe Webhook (Issue #92)
**Existing handler is production-quality** at `src/app/api/webhooks/stripe/route.ts`. Already handles:
- `checkout.session.completed` → creates org with PENDING_SETUP
- `customer.subscription.updated` → maps status + tier changes
- `customer.subscription.deleted` → cancels org
- `invoice.payment_failed` → flags PAST_DUE
- Idempotency via StripeEvent table

Issue #92 is mainly about **verifying** the existing handler works with correct Stripe keys, not rewriting it.

#### TikTok Hashtag Scraping (Issue #86)
No Patchright+TikTok hashtag patterns found on GitHub. Will follow existing scraper-pool patterns in `services/scraper-pool/src/`. The pool already has Patchright contexts, fingerprint rotation, proxy management. New route follows same pattern as profile scraping.

#### Instagram/Meta Comment API (Issue #87)
**Pattern** (from gitroomhq/postiz-app, DayMoonDevelopment/post-for-me):
```typescript
// Get comments on a media
const url = `https://graph.facebook.com/v20.0/${mediaId}/comments?access_token=${token}`;
// Reply to a comment
const url = `https://graph.facebook.com/v20.0/${commentId}/replies`;
await fetch(url, { method: 'POST', body: JSON.stringify({ message, access_token }) });
```

#### Gotchas Discovered
1. **X API reply restriction**: Since Feb 2024, programmatic replies only succeed if the original author @mentioned you or quoted your post. Quote tweets are the workaround (from Infatoshi/x-mcp comments).
2. **TikTok Content Posting API**: Unaudited apps must use `privacy_level: "SELF_ONLY"`. Need audit for PUBLIC_TO_EVERYONE.
3. **rss-parser**: Not in current package.json — needs install.
4. **Existing platform-apis/x.ts** already has OAuth 1.0a signing, chunked media upload, full posting. Thread posting is just looping `postTweet` with `reply.in_reply_to_tweet_id`.

---

### Chunk 1: Data Foundation — Prisma Schema + Seed (parallel-safe: yes)
**Issues:** #83 (org seed), #84 (RSS models), #86 (hashtag model)
**Files:**
- `prisma/schema.prisma` — Add `RssFeed`, `RssArticle`, `TrackedHashtag` models; add `rssFeeds`/`trackedHashtags` relations to Organization
- `prisma/seeds/saraiknowsball.ts` (new) — Seed org, TrackedCreators (X: AdamSchefter/NFL/MLB/NHL, TikTok: 5 creators, IG: 1), RssFeeds (ESPN NBA/NFL, NBA.com, Bleacher Report), TrackedHashtags (#basketball, #NBA, #NBAhighlights, #hoops, #balltok)
- `prisma/seed.ts` (new or update) — Entry point that calls saraiknowsball seed

**What to build:**
1. Add 3 new Prisma models (RssFeed, RssArticle, TrackedHashtag) to schema
2. Run `npx prisma migrate dev --name add_rss_and_hashtag_models`
3. Create seed script that creates saraiknowsball org + all monitored sources
4. Verify with `npx prisma db seed` or direct tsx execution

**Dependencies:** None

---

### Chunk 2: RSS Worker + Feed Router (parallel-safe: yes)
**Issues:** #84
**Files:**
- `src/server/workers/rss-polling-worker.ts` (new) — pg-boss cron every 15min, parse feeds via `rss-parser`, upsert RssArticle records
- `src/server/api/routers/rss.ts` (new) — tRPC CRUD for managing feeds (list, add, delete, toggle active)
- `src/server/api/root.ts` — Wire rss router
- `src/agents/specialists/trend-scout.ts` — Add `getRssArticles` tool replacing pending-integration stub

**What to build:**
1. Install `rss-parser` package
2. RSS polling worker: pg-boss scheduled job, fetches all active feeds, parses, upserts articles by URL uniqueness
3. tRPC router for feed management (subscribedProcedure)
4. Wire `getRssArticles` tool in trend-scout to query recent articles from DB

**Code to adapt:**
```typescript
import Parser from "rss-parser";
const parser = new Parser();
// For each active feed:
const feed = await parser.parseURL(rssFeed.url);
for (const item of feed.items) {
  await db.rssArticle.upsert({
    where: { url: item.link! },
    create: { feedId, organizationId, title: item.title!, url: item.link!, summary: item.contentSnippet, publishedAt: item.isoDate ? new Date(item.isoDate) : null },
    update: {},
  });
}
```

**Dependencies:** Chunk 1 (schema must exist)

---

### Chunk 3: X API Client + Trend Scout Integration (parallel-safe: yes, after Chunk 1)
**Issues:** #85
**Files:**
- `src/lib/x-api.ts` (new) — X API v2 client with Bearer Token auth, rate limiting, Redis caching
- `src/agents/specialists/trend-scout.ts` — Replace `searchTwitter` pending-integration with real X API call
- `src/server/workers/competitor-polling-worker.ts` — Add X API as faster alternative to scraper for X platform creators

**What to build:**
1. X API client class: `searchRecent(query, maxResults)`, `getUserTimeline(userId, maxResults)`, `getUserByUsername(username)`
2. Rate limiter: track remaining calls in Redis, respect 10k/month free tier
3. Redis cache: cache search results for 15min (`x:search:{hash}`)
4. Wire into trend-scout's `searchTwitter` tool
5. Optional: add X API path to competitor-polling-worker for X-platform creators

**Code to adapt:**
```typescript
const X_API_BASE = "https://api.twitter.com/2";

export async function searchRecentTweets(bearerToken: string, query: string, maxResults = 10) {
  const params = new URLSearchParams({
    query,
    max_results: String(Math.min(maxResults, 100)),
    "tweet.fields": "author_id,created_at,public_metrics",
    expansions: "author_id",
    "user.fields": "username,name,profile_image_url",
  });
  const res = await fetch(`${X_API_BASE}/tweets/search/recent?${params}`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (!res.ok) throw new Error(`X API error: ${await res.text()}`);
  return res.json();
}
```

**Dependencies:** Chunk 1

---

### Chunk 4: TikTok Hashtag Scraping + Competitor Worker Extension (parallel-safe: yes, after Chunk 1)
**Issues:** #86
**Files:**
- `services/scraper-pool/src/routes/hashtag.ts` (new) — POST /scrape/hashtag endpoint
- `services/scraper-pool/src/index.ts` — Register new route
- `src/server/workers/competitor-polling-worker.ts` — Add hashtag polling alongside creator polling

**What to build:**
1. New scraper-pool route: accept `{ hashtag, platform, limit }`, use Patchright to navigate to TikTok hashtag page, extract post data (URLs, view counts, descriptions, sounds, creators)
2. Apply existing fingerprint rotation + proxy from pool
3. Extend competitor-polling-worker to process TrackedHashtag records in same cron cycle

**Dependencies:** Chunk 1

---

### Chunk 5: Engagement Tools + Thread Writer + Safety (parallel-safe: no)
**Issues:** #87, #88
**Files:**
- `src/agents/specialists/engagement-responder.ts` — Replace pending-integration with real tools
- `src/agents/platforms/x/subagents/engagement-responder.ts` — Wire X mentions/reply tools
- `src/agents/platforms/tiktok/agent.ts` — Add comment fetch tools (via scraper-pool)
- `src/agents/platforms/instagram/agent.ts` — Add comment tools (via Graph API)
- `src/agents/specialists/thread-writer.ts` — Replace pending-integration with real thread posting
- `src/lib/x-api.ts` — Add `postThread()` method (chains postTweet calls)
- `src/agents/general/safety.ts` — Add reply validation (profanity, brand voice, rate limit 20/hr/platform)

**What to build:**
1. X engagement: fetch mentions via `GET /2/users/:id/mentions`, reply via existing `postXApi` with `in_reply_to_tweet_id`
2. TikTok comments: route through scraper-pool to fetch; use TikTok Content Posting API for replies (requires OAuth)
3. Instagram comments: use Graph API `GET /{media-id}/comments` and `POST /{comment-id}/replies`
4. Thread writer: split content at sentence boundaries into 280-char chunks, chain-post via X API, support numbering mode
5. Safety: add `validateReply()` to safety.ts — profanity check, brand voice alignment, rate limit counter in Redis

**Code to adapt (thread posting):**
```typescript
export async function postThread(tweets: string[], credentials: OAuthCredentials): Promise<string[]> {
  const postedIds: string[] = [];
  let previousId: string | undefined;
  for (const text of tweets) {
    const body: Record<string, unknown> = { text };
    if (previousId) body.reply = { in_reply_to_tweet_id: previousId };
    const result = await postTweet(body, credentials);
    postedIds.push(result.data.id);
    previousId = result.data.id;
  }
  return postedIds;
}
```

**Dependencies:** Chunk 3 (X API client)

---

### Chunk 6: Content Reproduction Pipeline (parallel-safe: no)
**Issues:** #89
**Files:**
- `src/agents/specialists/viral-teardown-agent.ts` — Replace pending-integration with real analysis tools
- `src/agents/specialists/script-agent.ts` — Replace pending-integration with real script generation tools
- `src/server/workflows/executor.ts` — Wire reproduction pipeline to media-engine
- `src/agents/clients/saraiknowsball/workflows/competitor-monitor.yaml` — Add reproduction trigger steps

**What to build:**
1. Viral teardown: wire `fetchViralContent` to scraper-pool for fetching post data, use LLM to analyze viral patterns
2. Script agent: wire `getScriptTemplate` to return real platform-specific templates from DB/config, generate scripts with brand voice
3. Reproduction pipeline flow: outlier detected → viral-teardown → script-agent → caption-writer → quality-scorer (gate ≥ 7) → media-engine queue → schedule posts
4. Add `reproduction: true` flag to WorkflowRunLog for audit
5. Update competitor-monitor.yaml with full reproduction steps

**Dependencies:** Chunks 3, 5 (X API + engagement tools must exist for full pipeline)

---

### Chunk 7: Platform Posting Agents + Stripe Verification (parallel-safe: partially)
**Issues:** #91, #92
**Files:**
- `src/agents/platforms/tiktok/tools/post.ts` (new or update agent.ts) — Wire real TikTok posting
- `src/agents/platforms/instagram/tools/post.ts` (new or update agent.ts) — Wire real Instagram posting
- `src/agents/platforms/x/tools/post.ts` (new or update agent.ts) — Wire real X posting
- `src/server/workers/post-worker.ts` — Ensure pg-boss queue handles scheduling, rate limits, status tracking
- `src/app/api/webhooks/stripe/route.ts` — Add `invoice.paid` handler, verify end-to-end
- `.env.example` — Document all required env vars for saraiknowsball (#90)

**What to build:**
1. Platform posting: all three platform agents already have API implementations in `src/server/services/platform-apis/`. Wire the agent tools to call through `postContent()` service which routes to correct API
2. Post scheduling: extend post-worker to handle future-dated scheduling, respect per-platform rate limits
3. Stripe: add `invoice.paid` event handler, verify existing handlers work with test keys
4. Env documentation: update .env.example with saraiknowsball-specific vars (X_BEARER_TOKEN, PROXY_*, R2_*, RESEND_API_KEY)

**Dependencies:** Chunks 3, 5 (X API, engagement tools)

---

### Chunk 8: Analytics Dashboard + Final Wiring (parallel-safe: no)
**Issues:** #93
**Files:**
- `src/server/api/routers/analytics.ts` (new) — tRPC router for analytics queries
- `src/server/api/root.ts` — Wire analytics router
- `src/app/analytics/page.tsx` (new) — Dashboard with summary cards, charts, tables
- `src/app/sidebar.tsx` — Add Analytics nav link
- `src/agents/specialists/analytics-reporter.ts` — Replace pending-integration with real DB queries

**What to build:**
1. Analytics tRPC router: queries for post performance (PostRecord + PostSnapshot joins), engagement trends, best content, competitor comparison, platform breakdown
2. Dashboard page: summary cards (total views, avg engagement, best post), engagement over time chart (last 30 days), recent posts table, competitor comparison, platform breakdown
3. Analytics reporter agent: wire `queryAnalytics` tool to run real Prisma queries against PostSnapshot/TrackedPost tables
4. Sidebar: add `{ href: "/analytics", label: "Analytics" }` to NAV_ITEMS and PROTECTED_PREFIXES

**Dependencies:** Chunk 1 (schema), Chunk 7 (post records exist)

---

### Execution Order
1. **Chunk 1** — Data Foundation (start immediately)
2. **Chunk 2** — RSS Worker (after Chunk 1) ⚡ parallel with 3, 4
3. **Chunk 3** — X API Client (after Chunk 1) ⚡ parallel with 2, 4
4. **Chunk 4** — TikTok Hashtag Scraping (after Chunk 1) ⚡ parallel with 2, 3
5. **Chunk 5** — Engagement + Thread Writer (after Chunk 3)
6. **Chunk 6** — Content Reproduction Pipeline (after Chunks 3, 5)
7. **Chunk 7** — Platform Posting + Stripe (after Chunks 3, 5)
8. **Chunk 8** — Analytics Dashboard (after Chunk 7)

```
Chunk 1 ──┬── Chunk 2 (RSS) ────────────────────────┐
          ├── Chunk 3 (X API) ── Chunk 5 (Engage) ──┤── Chunk 6 (Repro) ── Chunk 7 (Post/Stripe) ── Chunk 8 (Analytics)
          └── Chunk 4 (Hashtag) ─────────────────────┘
```

### Issue → Chunk Mapping
| Issue | Title | Chunk |
|-------|-------|-------|
| #83 | Create Organization + seed sources | 1 |
| #84 | RSS polling worker | 1 (schema) + 2 (worker) |
| #85 | X/Twitter Bearer Token search | 3 |
| #86 | TikTok hashtag scraping | 1 (schema) + 4 (scraper) |
| #87 | Engagement-responder tools | 5 |
| #88 | Thread-writer tools | 5 |
| #89 | Content reproduction pipeline | 6 |
| #90 | Configure env vars | 7 (documented in .env.example) |
| #91 | Platform posting agents | 7 |
| #92 | Stripe webhook verification | 7 |
| #93 | Analytics dashboard | 8 |
