# Nexus: Multi-Agent Social Media Suite — Architecture Plan

## Execution Plan (Approved)

1. `mkdir nexus-suite && cd nexus-suite`
2. Create `ARCHITECTURE.md` — paste full plan (Decisions 1-10 + Implementation Phases + Verification)
3. Create `CLAUDE.md` — project instructions referencing `@ARCHITECTURE.md`
4. Begin Phase 1: `docker-compose.yml` with all 10 services → stop for approval before Prisma schema

## Context

Building a multi-tenant SaaS platform that orchestrates hyper-focused AI agents to analyze video analytics, identify trends, track competitors, and create/distribute content across social platforms. Based on deep analysis of 14 repositories, we fork **ai-content-engine** as the base (it already has 7 Mastra agents, ML pipeline, 30+ Prisma models, 14 pg-boss workers, 6 platform integrations) and selectively adopt patterns from b0t (YAML workflows), pocket-agent (tool wrapping/safety), pocket-agent-cli (CLI tooling), content-cat (FAL.ai/FFmpeg), and 6 scraping/bypass repos.

---

## Decision 1: Base Codebase — Fork ai-content-engine

**Why not pocket-agent**: Electron desktop app, single-agent, SQLite, no web/SaaS infrastructure. Useful patterns (tool wrapping, session isolation) are ~200 lines portable in a day.

**Why not fresh**: Rebuilding 30+ DB models, 17 service modules, 7 agents, 14 workers, 6 platform integrations = months of redundant work.

**What we inherit from ai-content-engine**:
- 7 Mastra agents with delegation pattern (Orchestrator→Content/Script/Production/Distribution/Engagement/Admin)
- Full autopilot pipeline: scrape→analyze→script→render→distribute→engage
- ML stack: Thompson Sampling bandits, Random Forest adaptability, pgvector similarity, weekly retrain
- 14 pg-boss workers, SSE broadcasting, budget gates, approval gates
- NextAuth v5, tRPC, Prisma 7, PostgreSQL, Redis
- Python scraper sidecar (FastAPI)
- Onion architecture (domain→repos→services→modules→api→app)

**What we adopt from other repos**:

| Source | What | Effort |
|--------|------|--------|
| b0t | YAML workflow engine (executor, parallel-executor, validator, schema, control-flow, module-registry) | ~2 weeks |
| pocket-agent | `wrapToolHandler()` diagnostics, `AsyncLocalStorage` session isolation, safety hooks | ~1 day |
| pocket-agent-cli | 81-integration Go CLI as subprocess tool for agents | ~2 days |
| content-cat | FAL.ai typed clients (Nano Banana Pro), FFmpeg pipeline builder | ~3 days |
| Scraping repos | Patchright stealth browser, Turnstile solver (native TS port), bypass chain | ~1 week |

---

## Decision 2: Docker + Multi-Tenant Infrastructure

### Container Topology (10 services)

| Service | Role | Resource Profile | Proxy Type |
|---------|------|-----------------|------------|
| **nexus-app** | Next.js web — dashboard, tRPC, Mastra chat, SSE, /admin panel | 2 CPU, 4GB RAM | None |
| **nexus-worker** (x2) | pg-boss content pipeline + BullMQ YAML workflow executor | 2 CPU, 4GB RAM | None |
| **scraper-pool** | 8 parallel Patchright agents + bypass chain. Bursty on-demand tasks | 4 CPU, 8GB RAM, 4GB shm | Rotating residential mesh |
| **warming-service** | Long-running Patchright sessions for account warming. Idle-heavy, async | 2 CPU, 4GB RAM, 2GB shm | Strict static residential (1:1 per account) |
| **media-engine** | yt-dlp downloads + FFmpeg variation rendering | 4 CPU, 8GB RAM | Cheap datacenter/ISP |
| **ml-sidecar** | Python — Thompson Sampling, Random Forest, embeddings | 2 CPU, 4GB RAM | None |
| **scrapling-sidecar** | Python fallback scraper — Scrapling 3-tier fetcher | 1 CPU, 2GB RAM | Rotating |
| **infisical** | Infisical secrets manager — all tokens/proxies/session keys. Persistent volume (NOT ephemeral) | 2 CPU, 2GB RAM | None |
| **db** | pgvector/pgvector:pg17 | Persistent volume | — |
| **redis** | Redis 7 — BullMQ, cookie cache, rate limits, proxy mapping, LLM spend tracking, job queues | Persistent volume | — |

**Separate pg-boss/Redis queues**: `scrape:task` (scraper-pool), `warm:task` (warming-service), `media:task` (media-engine) — scale independently

**Key decisions**:
- **Scraper Pool vs Media Engine split**: Scraper Pool handles stealth browser ops (time-sensitive CF/Turnstile challenges) on expensive residential proxies. Media Engine handles bandwidth-heavy downloads/renders on cheap datacenter proxies. Distinct CPU/memory limits prevent video renders from starving CAPTCHA-solving
- **Communication**: Redis pub/sub for async handoffs between services (scraper pool hands download URLs to media engine)
- **Storage**: Cloudflare R2 (S3-compatible, zero egress fees) for all video files, thumbnails, variations

### Database Schema — Multi-Tenancy + Stripe (SwaS Model)

**Business model**: "Software with a Service" — high-ticket setup fee + monthly retainer. Each client gets custom agent configuration, dedicated proxy allocation, burner fleet provisioning by our team.

**Core tables** (conceptual — full Prisma schema built during implementation):

**Organization** — tenant root:
- Stripe fields: `stripeCustomerId`, `stripeSubscriptionId`, `setupPaymentIntentId`
- Status fields: `subscriptionStatus` (INACTIVE|ACTIVE|PAST_DUE|CANCELED|UNPAID|PAUSED), `onboardingStatus` (PENDING_PAYMENT|PENDING_SETUP|ACTIVE|SUSPENDED)
- Feature gates (denormalized from tier): `maxAccounts`, `maxWorkflowRuns`, `maxVideosPerMonth`, `mlFeaturesEnabled`, `multiplierEnabled`, `dailyLlmBudgetCents` (500 Pro, 1500 Multiplier)
- `brandConfig` (Json) — org-scoped brand voice, content strategy
- Relations to all content tables via `organizationId`

**OrgMember** — user↔org join with role (OWNER|ADMIN|MEMBER)

**OrgPlatformToken** — per-account platform credentials:
- `accountType`: PRIMARY (official API posting) or SECONDARY (browser automation posting)
- `infisicalSecretId` — Infisical Secret ID (e.g., `orgs/{orgId}/tokens/{tokenId}`). DB stores ONLY this reference, never raw credentials
- Health tracking: `healthScore`, `consecutiveFailures`, `circuitState` (CLOSED|OPEN|HALF_OPEN)
- `infisicalProxyId` — Infisical Secret ID for assigned proxy URL (never stored in DB)
- `fingerprintProfileId` — links to stored browser fingerprint
- `sessionStoragePath` — R2 key for persistent browser session (cookies/localStorage)
- `warmupStatus` (NOT_STARTED|WARMING|READY) — account warming state

**BrowserProfile** — persistent fingerprint per burner account:
- `userAgent`, `screenWidth`, `screenHeight`, `hardwareConcurrency`, `platform`, `languages`
- `canvasNoiseSeed`, `webglVendor`, `webglRenderer` — deterministic but unique per profile
- `timezone`, `locale`
- Generated once on account creation, reused consistently across all sessions

**StripeEvent** — idempotency table for webhook dedup (keyed by Stripe event ID)

**UsageRecord** — per-org per-metric per-period counters for tier enforcement

### Stripe Checkout: Setup Fee + Recurring Subscription

**Before (Traditional SaaS)**: Single Stripe Checkout Session creates a subscription. User gets immediate access.

**The Catalyst**: SwaS model requires one-time setup fee (agent tuning, proxy provisioning, fleet configuration) + monthly retainer. User should NOT get access until our team finishes provisioning.

**After (SwaS Flow)**:
1. Stripe Checkout Session created with TWO line items: one-time `setup_fee` price + recurring `subscription` price
2. On `checkout.session.completed` webhook: create Organization with `onboardingStatus: PENDING_SETUP`
3. User sees "Provisioning" dashboard — cannot access tools/agents
4. Admin manually configures client's agents, proxies, burner fleet
5. Admin changes `onboardingStatus` → `ACTIVE` via admin panel
6. User can now access main dashboard and trigger workflows

### Four-Layer Auth Gate

1. **Stripe Webhook** → updates `subscriptionStatus` + denormalizes feature gates
2. **NextAuth Session Callback** → blocks login if `subscriptionStatus` not ACTIVE/PAUSED or `onboardingStatus` not ACTIVE
3. **tRPC `subscribedProcedure`** → checks status + feature gates per route
4. **tRPC `onboardedProcedure`** → checks `onboardingStatus === ACTIVE` (blocks PENDING_SETUP users from tool routes)

### Pricing Tiers (SwaS)

| Tier | Setup Fee | Monthly | Accounts | Multiplier | ML | Dedicated Proxies | LLM Budget |
|------|-----------|---------|----------|------------|-----|-------------------|------------|
| Pro | $500 | $149/mo | 3 | No | Basic analytics | Shared pool | $5/day |
| Multiplier | $1,500 | $499/mo | 25+ | Yes | Full ML stack | Dedicated residential | $15/day |
| Enterprise | Custom | Custom | Unlimited | Yes | Full + custom models | Dedicated + geo-targeted | Custom |

---

## Decision 3: YAML Workflow + CLI + Agent Architecture

### YAML Workflow Integration (from b0t)

Port these files from b0t into `src/server/workflows/`:
- `executor.ts` — core executor with `{{variable}}` interpolation
- `parallel-executor.ts` — dependency graph → wave-based `Promise.allSettled`
- `workflow-validator.ts` — 12-layer AJV validation
- `workflow-schema.ts` — JSON schema for workflow structure
- `control-flow.ts` — `ActionStep`, `ConditionStep`, `ForEachStep`, `WhileStep`

**New step type** — `agent-delegate` for invoking Mastra agents mid-workflow:
```yaml
steps:
  - id: write-hooks
    type: agent-delegate
    agent: hook-writer
    prompt: "Write 5 viral hooks for: {{trends}}"
    outputAs: hooks
```

YAML workflows with `trigger.type: "cron"` registered as pg-boss scheduled jobs, namespaced per org.

### pocket-agent-cli Integration

Go binary installed in worker/scraper-pool Docker images. Invoked as subprocess with JSON output.

Per-org credentials bridged: fetch from Infisical via `OrgPlatformToken.infisicalSecretId` → write temp pocket config → execute → cleanup (discard credentials from memory).

### Agent Directory Structure

```
src/agents/
  orchestrator/         # Nexus Orchestrator + Workflow Agent (Tier 1)
  platforms/            # Platform Main Agents + Tier 2.5 sub-agents
    youtube/
    tiktok/
    instagram/
    linkedin/
    x/
      agent.ts
      subagents/        # X-News-Scout, X-Tone-Translator, X-Engagement-Responder
    facebook/
  specialists/          # Core Tier 3 agents (SEO, Hook Writer, Script, etc.)
  clients/              # Per-org plugin directory
    {org_id}/
      agents/           # Custom agent overrides
      tools/            # Niche-specific tools
      workflows/        # Custom YAML templates
      brand-prompt.md   # Brand System Prompt (generated by Brand Persona Agent)
  my_approach/          # Brand voice, content strategy, platform mix (org-scoped)
  workflows/templates/  # Built-in YAML templates (daily-pipeline, engagement-sweep, etc.)
  general/              # Shared: tool-wrappers.ts, safety.ts, memory.ts, prompts.ts, prepareContext()
  coder/                # Internal debugging agents
```

### Hyper-Focused Agent Hierarchy

**Tier 1 — Orchestration:**
| Agent | Role |
|-------|------|
| Nexus Orchestrator | Top-level router, delegates to platform agents or cross-cutting specialists |
| Workflow Agent | Interprets NL→YAML, validates, submits to BullMQ |

**Tier 2 — Platform Main Agents** (one per platform, delegates to Tier 3):
YouTube, TikTok, Instagram, LinkedIn, X, Facebook

**Tier 3 — Hyper-Focused Specialists** (single-task, shared across platforms):

| Agent | Single Task | Restricted Tools |
|-------|------------|-----------------|
| SEO Agent | Keyword research + optimization | Tavily search, YouTube search CLI, keyword metrics |
| Hook Writer | Viral opening hooks (first 3s) | ViralPattern DB, winner logs, platform templates |
| Title Generator | Click-worthy titles | A/B data, CTR prediction (ML), char limits |
| Thumbnail Creator | Design/prompt thumbnails | FAL.ai Nano Banana Pro, text overlay rules |
| Script Agent | Full video scripts | OpenRouter LLM, brand voice, quality gate |
| Caption Writer | Platform-specific captions | Char limits, emoji/hashtag rules, brand voice |
| Hashtag Optimizer | Research + select hashtags | CLI trending, analytics, performance data |
| Thread Writer | Multi-post threads | Threading APIs, chunking, narrative templates |
| Article Writer | Long-form SEO articles | OpenRouter, keyword data, internal linking |
| Trend Scout | Discover trending topics | CLI twitter/hackernews/reddit, Tavily |
| Engagement Responder | Reply to comments/mentions | Platform APIs, sentiment, reply templates |
| Analytics Reporter | Performance reports | Analytics queries, trend detection |
| Content Repurposer | Adapt across platforms | Format conversion, aspect ratio handling |
| Quality Scorer | Score before distribution | Editing rules, quality thresholds |
| Variation Orchestrator | Analyze source video, output precise FFmpeg transform JSON for 4-layer hash alteration | FFmpeg template DB, video metadata parser |
| Brand Persona Agent | Analyze client website/competitors/brand notes → generate Brand System Prompt | Web scraper (scraper-pool), Brand DB, onboarding data |
| Viral Tear-down Agent | Analyze outlier video transcript/pacing/visuals → generate "Viral Recipe" report | Transcript extractor, pacing analyzer, competitor post data |

**Tier 2.5 — Platform-Specific Specialists** (native to each Platform Main Agent, not shared):

Each Platform Main Agent has sub-agents tuned for that platform's native dialect and mechanics. Example for X (Twitter) Main Agent:

| Sub-Agent | Task |
|-----------|------|
| X-News-Scout | Scrape trending X topics + niche news formatted for short-form text |
| X-Tone-Translator | Rewrite generic content into platform-native dialect using client brand voice |
| X-Engagement-Responder | Quote-tweets, witty replies, automated DMs based on sentiment |

Similar Tier 2.5 specialists exist per platform.

### Agent Data Minimization (Safety Rule)

The nexus-worker MUST parse and minimize all data before handing it to a Mastra agent. Each agent receives ONLY what it needs. Enforced at the delegation layer via `prepareContext()` functions.

### Client Plugin Architecture (Per-Org Extensibility)

**Resolution order** (YAML workflow engine checks):
1. `src/agents/clients/{org_id}/agents/{agentName}` — client-specific override
2. `src/agents/platforms/{platform}/subagents/{agentName}` — platform Tier 2.5
3. `src/agents/specialists/{agentName}` — core Tier 3 generic

---

## Decision 4: Web Operations Pool (8 Parallel Scraping Agents)

### Architecture

Separate Docker service (`scraper-pool/`) with:
- **AgentPool**: 8 pre-warmed Patchright `BrowserContext` instances behind async semaphore
- **Per-domain rate limiting**: Token bucket in Redis (`scraper:ratelimit:{domain}`)
- **Proxy rotation**: Residential proxies, sticky per domain, health tracking
- **Fingerprint rotation**: New fingerprint every 50 tasks via `browserforge`

### Bypass Decision Chain

```
1. Plain HTTP fetch
   └── Blocked? →
2. Patchright stealth browser
   ├── Cloudflare challenge → check cookie cache (Redis 30min TTL)
   │   └── No cache → Turnstile solver (native TS port, click + poll token)
   ├── reCAPTCHA v2 → audio-first (download audio → speech-to-text → submit)
   │   └── Fail → vision LLM fallback (GPT-4o via OpenRouter)
   ├── Image CAPTCHA → vision LLM (GPT-4o screenshot analysis)
   └── Unknown block →
3. Camoufox fallback (Firefox, different fingerprint family)
   └── Fail →
4. Scrapling Python sidecar (last resort, 3-tier fetcher)
```

### Integration with Nexus

Jobs submitted via pg-boss queue `scrape:task`, results on `scrape:result`. Streaming via Redis pub/sub `scrape:stream:{taskId}`.

---

## Decision 5: Competitor Tracking

### Data Model (Conceptual)

- **TrackedCreator**: orgId, platform, username, profileUrl, avatarUrl, followerCount, isActive, autoReproduce, outlierThreshold (default 3.0), pollInterval (default 3600s), lastPolledAt
- **TrackedPost**: creatorId, externalId, title, url, thumbnailUrl, views, likes, comments, publishedAt, isOutlier, outlierScore, reproduced
- **PostSnapshot**: postId, views, likes, comments, capturedAt

### Outlier Detection

pg-boss cron every 15min → poll creators due for check → scrape latest posts via scraper pool → compare against creator's median (last 30 posts) → `outlierScore = (views - median) / stddev` → if > threshold within first 24h: mark outlier → if `autoReproduce`: queue reproduce workflow.

### UI Flow

- /competitors page with [+ Track Creator] → paste profile URL → scraper pool extracts profile
- Per-creator: follower count, last check time, Set & Forget toggle, threshold config
- Post list with outlier indicators, [Analyze] and [Reproduce] buttons
- Set & Forget ON → auto-triggers reproduce workflow on outlier detection

---

## Decision 6: Content Multiplier Engine + Burner Fleet Architecture

### 6A. Proxy & Fingerprint Management

Each burner account gets a permanent, unique `BrowserProfile` record:
- Fingerprint generation (adapted from CloudflareBypass `BrowserConfig.generate_random_config()`)
- Canvas noise seed: Deterministic random seed per profile
- WebGL spoofing: Per-profile vendor + renderer strings
- Sticky proxy: One dedicated residential proxy IP permanently assigned per account

**Proxy Health Tracking**: ProxyAllocation model tracks status (ACTIVE|BURNED|ROTATING). Burned IPs never reassigned.

### 6B. Session & Cookie Storage

Persistent session architecture:
1. Initial manual login by admin
2. Export session via Patchright's `storageState()`
3. Encrypt & store in R2 at `sessions/{orgId}/{accountId}/state.json`
4. Before each action: download → decrypt → inject
5. After each action: re-export → re-encrypt → upload
6. Cookie rotation: admin alerted for manual re-login on expiry

**Automated Verification Checkpoint Handler**: IMAP + SMS code catching for platform verification challenges.

### 6C. Video Hash Alteration (Four-Layer)

- **Layer 1 — File-level hash**: Strip metadata, randomize timestamps, re-mux
- **Layer 2 — Visual perceptual hash**: Mirror, crop, speed, color shift, padding, noise, aspect adjust
- **Layer 3 — Audio fingerprint**: Pitch shift, tempo adjust, white noise floor, bitrate change
- **Audio Copyright Safety**: Detect music vs speech-only. Strip copyrighted audio, use platform's native "Add Sound" UI
- **Layer 4 — Structural uniqueness**: Vary CRF, preset, profile, GOP, pixel format

Verification: post-generation pHash + audio fingerprint collision check (Hamming distance > 5).

### 6D. Account Warming Logic

YAML-driven 4-phase warming over 7-14 days:
- Phase 1 (Days 1-3): Passive browsing
- Phase 2 (Days 4-7): Light engagement
- Phase 3 (Days 8-10): First posts
- Phase 4 (Day 11+): Production ready

### 6E. Hybrid Posting Strategy

| Account Type | Posting Method | Auth |
|-------------|---------------|------|
| PRIMARY | Official platform APIs | OAuth 2.0 tokens |
| SECONDARY (burners) | Patchright browser automation | Persistent session cookies |

### 6F. Distribution Scheduler + Circuit Breaker

- Stagger: sort by healthScore, random 30-120min intervals, +-15min jitter, daily caps, 10% skip probability
- Circuit breaker: CLOSED → 3 failures → OPEN → 5min → HALF_OPEN → success/fail

### 6G. Database Models (Conceptual)

- **SourceVideo**: orgId, url, platform, r2StorageKey, duration
- **VideoVariation**: sourceVideoId, variationIndex, transforms, r2StorageKey, fileHash, pHash, audioFingerprint, caption, status
- **PostRecord**: accountId, variationId, platform, scheduledAt, postedAt, status, externalPostId, caption
- **BrowserProfile**: accountId, fingerprint fields (UA, screen, canvas seed, WebGL, timezone, locale)
- **AccountWarmingLog**: accountId, phase, action, timestamp, success

---

## Decision 7: Proxy Provider — IPRoyal (Modular Interface)

Default provider: IPRoyal. Modular `ProxyManager` class — swap providers via `.env` only.

Env config: `PROXY_PROVIDER`, `PROXY_API_KEY`, `PROXY_BASE_URL`, `PROXY_RESIDENTIAL_ENDPOINT`, `PROXY_DATACENTER_ENDPOINT`

---

## Decision 8: Post-Payment Onboarding Wizard

**Flow**: Stripe checkout → webhook → create org (PENDING_PAYMENT) → redirect to `/onboarding` wizard

**Wizard steps**: Niche & brand info → Target competitors → Content preferences → Confirmation

**New model**: OnboardingSubmission (orgId, niche, brandVoice, tonePreferences, competitorUrls, platforms, postingFrequency, contentStyle, additionalNotes, submittedAt)

---

## Decision 9: Secrets Management — Infisical

Infisical as 10th Docker container with persistent volume:
- One Infisical project per org
- DB stores only Infisical Secret IDs — never raw credentials
- Fetch-use-discard pattern for all credential access
- Per-service Machine Identity tokens with scoped access
- Client plugins: NO Infisical access

---

## Decision 10: LLM Spend Circuit Breaker

Redis-backed per-org daily budget tracker:
- Redis key: `llm:spend:{orgId}:{YYYY-MM-DD}` — atomic counter in cents, TTL 48h
- `trackLlmSpend()` wrapper on all OpenRouter calls
- Pre-flight `checkLlmBudget(orgId)` before every `agent.generate()`
- Workflow halt + SSE notification on budget breach
- Auto-resume at midnight UTC
- Dashboard widget: real-time spend bar

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
1. Fork ai-content-engine → rename to Nexus
2. Add Organization + OrgMember + Stripe models to Prisma schema
3. Implement Stripe webhook handler + 4-layer auth gate
4. Build Docker compose with all 10 services
5. Configure Infisical container with persistent volume
6. Add `organizationId` to all existing content tables
7. Build hybrid admin system (/admin UI + CLI provisioning suite)
8. Build post-payment `/onboarding` wizard
9. Build "Provisioning" dashboard
10. Build modular `ProxyManager` class

### Phase 2: Workflow Engine (Week 3-4)
11. Port b0t workflow engine
12. Add `agent-delegate` step type
13. Build `trackLlmSpend()` + `checkLlmBudget()` + Redis spend counter
14. Install pocket-agent-cli + build CLI bridge service
15. Implement agent directory structure

### Phase 3: Agent Refactor (Week 5-6)
16. Refactor existing agents into hyper-focused specialists
17. Create Platform Main Agents
18. Wire delegation chain
19. Add `wrapToolHandler()` diagnostics + safety hooks

### Phase 4: Scraper Pool + Media Engine + Warming Service (Week 7-9)
20. Build scraper-pool service
21. Build media-engine service
22. Build warming-service
23. Port Turnstile solver, implement bypass chain
24. Wire separate pg-boss queues
25. Build CLI admin commands

### Phase 5: Competitor Tracking (Week 10)
26. Add TrackedCreator/TrackedPost/PostSnapshot models
27. Build competitor polling + outlier detection
28. Build /competitors dashboard
29. Wire auto-reproduce trigger

### Phase 6: Content Multiplier + Burner Fleet (Week 11-13)
30. Add BrowserProfile + AccountWarmingLog models
31. Build fingerprint generator + persistent session manager
32. Build account warming workflow
33. Build FFmpeg 4-layer hash alteration pipeline
34. Build pHash/audio fingerprint verification
35. Build distribution scheduler + circuit breaker
36. Build hybrid posting
37. Add SourceVideo/VideoVariation/PostRecord models
38. Create content-multiply workflow + dashboard

### Phase 7: Polish (Week 14-15)
39. Usage tracking + tier enforcement
40. R2 integration for all storage
41. Monitoring (Prometheus + Grafana)
42. E2E testing

---

## Verification

- **Auth gate**: Test org lifecycle from INACTIVE → Stripe webhook → PENDING_SETUP → admin ACTIVE
- **YAML workflows**: Parallel + sequential step execution + variable interpolation
- **Scraper pool**: CF-protected page bypass + cookie caching
- **Media engine**: yt-dlp download → R2 → FFmpeg variation with unique hashes
- **Competitor tracking**: Polling + snapshots + outlier detection + auto-reproduce
- **Multiplier**: Source video → N variations → unique hashes + pHash distance > 5 → staggered schedule
- **Burner fleet**: Unique BrowserProfile → warming workflow → correct fingerprint/proxy/session
- **Proxy health**: Ban → BURNED → excluded from future assignments
- **Verification handler**: IMAP/SMS code catching + auto-submission
- **Audio copyright**: Copyrighted audio detection → strip → platform "Add Sound" UI
- **Agent hierarchy**: Orchestrator → Platform → Specialist delegation chain
- **Infisical secrets**: Secret ID reference only in DB → fetch from worker → persist across restarts
- **LLM budget**: Redis counter → budget breach → workflow halt → midnight reset

---

## Resolved Decisions

| Question | Answer |
|----------|--------|
| Base codebase | Fork ai-content-engine |
| Object storage | Cloudflare R2 (zero egress fees) |
| Platform posting | Hybrid: official APIs for primary, browser automation for burners |
| Video downloads | Separate Media Processing Engine (datacenter proxies) |
| Account warming | Separate Warming Service (strict IP stickiness) |
| Pricing model | SwaS: Pro $500+$149/mo, Multiplier $1500+$499/mo, Enterprise custom |
| Admin system | Hybrid: /admin UI + CLI provisioning suite |
| Proxy provider | IPRoyal default, modular ProxyManager interface |
| Onboarding | Post-payment wizard → admin review → CLI provision → activate |
| Secrets management | Infisical (10th container, persistent volume) |
| LLM cost control | Redis-backed per-org daily budget, workflow auto-halt |
| Total services | 10 containers |
