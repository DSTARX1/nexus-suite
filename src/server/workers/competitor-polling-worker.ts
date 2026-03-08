import PgBoss from "pg-boss";
import { db } from "@/lib/db";

// ── Config ───────────────────────────────────────────────────

const CRON_NAME = "competitor:poll";
const CRON_SCHEDULE = "*/15 * * * *"; // every 15 min
const SCRAPLING_URL =
  process.env.SCRAPLING_URL ?? "http://scrapling-sidecar:8000";
const SCRAPLING_TIMEOUT = 60_000;

// ── Sidecar types ────────────────────────────────────────────

interface ScrapedPost {
  title?: string | null;
  url?: string | null;
  thumbnail?: string | null;
  views?: string | null;
  likes?: string | null;
  comments?: string | null;
  published_at?: string | null;
}

interface ScrapePostsResponse {
  posts: ScrapedPost[];
  count: number;
  tier_used: number;
}

// ── Helpers ──────────────────────────────────────────────────

function parseCount(value: string | null | undefined): number {
  if (!value) return 0;
  const cleaned = value.replace(/[^0-9.kmb]/gi, "").toLowerCase();
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  if (cleaned.endsWith("b")) return Math.round(num * 1_000_000_000);
  if (cleaned.endsWith("m")) return Math.round(num * 1_000_000);
  if (cleaned.endsWith("k")) return Math.round(num * 1_000);
  return Math.round(num);
}

function deriveExternalId(post: ScrapedPost, index: number): string {
  if (post.url) {
    // Extract last path segment or video ID as external ID
    const match = post.url.match(/\/([^/?#]+)(?:[?#]|$)/);
    if (match) return match[1];
  }
  return `unknown-${index}`;
}

// ── Worker ───────────────────────────────────────────────────

let boss: PgBoss | null = null;

async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss(process.env.DATABASE_URL!);
    await boss.start();
  }
  return boss;
}

const TASK_QUEUE = "competitor:task";

// ── Outlier detection ────────────────────────────────────────

async function detectOutliers(
  boss: PgBoss,
  creatorId: string,
  organizationId: string,
  outlierThreshold: number,
  autoReproduce: boolean,
  postIds: string[],
): Promise<void> {
  for (const postId of postIds) {
    const snapshots = await db.postSnapshot.findMany({
      where: { postId },
      orderBy: { capturedAt: "asc" },
      select: { views: true },
    });

    // Need at least 3 snapshots for meaningful stats
    if (snapshots.length < 3) continue;

    const viewValues = snapshots.map((s) => s.views);
    const mean = viewValues.reduce((a, b) => a + b, 0) / viewValues.length;
    const variance =
      viewValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
      viewValues.length;
    const stddev = Math.sqrt(variance);

    // Avoid division by zero — if no variance, no outlier
    if (stddev === 0) continue;

    const currentViews = viewValues[viewValues.length - 1];
    const zScore = (currentViews - mean) / stddev;
    const isOutlier = zScore > outlierThreshold;

    await db.trackedPost.update({
      where: { id: postId },
      data: {
        isOutlier,
        outlierScore: isOutlier ? zScore : null,
      },
    });

    if (isOutlier && autoReproduce) {
      const post = await db.trackedPost.findUnique({
        where: { id: postId },
        select: { reproduced: true, url: true },
      });

      if (post && !post.reproduced && post.url) {
        await boss.send(TASK_QUEUE, {
          jobType: "reproduce",
          postId,
          url: post.url,
          organizationId,
        });

        console.log(
          `[competitor-poll] outlier detected postId=${postId} z=${zScore.toFixed(2)} — enqueued reproduce`,
        );
      }
    }
  }
}

// ── Poll single creator ─────────────────────────────────────

async function pollCreator(
  pgBoss: PgBoss,
  creator: {
    id: string;
    organizationId: string;
    profileUrl: string;
    platform: string;
    outlierThreshold: number;
    autoReproduce: boolean;
  },
): Promise<void> {
  const resp = await fetch(`${SCRAPLING_URL}/scrape/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: creator.profileUrl,
      platform: creator.platform.toLowerCase(),
    }),
    signal: AbortSignal.timeout(SCRAPLING_TIMEOUT),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(
      `[competitor-poll] scrape failed for creator=${creator.id}: ${resp.status} ${body}`,
    );
    return;
  }

  const data = (await resp.json()) as ScrapePostsResponse;

  const upsertedPostIds: string[] = [];

  for (let i = 0; i < data.posts.length; i++) {
    const scraped = data.posts[i];
    const externalId = deriveExternalId(scraped, i);
    const views = parseCount(scraped.views);
    const likes = parseCount(scraped.likes);
    const comments = parseCount(scraped.comments);

    const post = await db.trackedPost.upsert({
      where: {
        creatorId_externalId: {
          creatorId: creator.id,
          externalId,
        },
      },
      create: {
        creatorId: creator.id,
        externalId,
        title: scraped.title ?? null,
        url: scraped.url ?? null,
        thumbnailUrl: scraped.thumbnail ?? null,
        views,
        likes,
        comments,
      },
      update: {
        title: scraped.title ?? undefined,
        url: scraped.url ?? undefined,
        thumbnailUrl: scraped.thumbnail ?? undefined,
        views,
        likes,
        comments,
      },
    });

    await db.postSnapshot.create({
      data: {
        postId: post.id,
        views,
        likes,
        comments,
      },
    });

    upsertedPostIds.push(post.id);
  }

  // Outlier detection + auto-reproduce trigger
  await detectOutliers(
    pgBoss,
    creator.id,
    creator.organizationId,
    creator.outlierThreshold,
    creator.autoReproduce,
    upsertedPostIds,
  );

  await db.trackedCreator.update({
    where: { id: creator.id },
    data: { lastPolledAt: new Date() },
  });

  console.log(
    `[competitor-poll] polled creator=${creator.id} posts=${data.posts.length}`,
  );
}

async function handlePollCron(): Promise<void> {
  const now = new Date();
  const b = await getBoss();

  const dueCreators = await db.trackedCreator.findMany({
    where: {
      isActive: true,
      OR: [
        { lastPolledAt: null },
        {
          lastPolledAt: {
            lt: new Date(now.getTime() - 1000), // placeholder, refined below
          },
        },
      ],
    },
    select: {
      id: true,
      organizationId: true,
      profileUrl: true,
      platform: true,
      pollInterval: true,
      lastPolledAt: true,
      outlierThreshold: true,
      autoReproduce: true,
    },
  });

  // Filter by individual pollInterval
  const due = dueCreators.filter((c) => {
    if (!c.lastPolledAt) return true;
    return c.lastPolledAt.getTime() + c.pollInterval * 1000 < now.getTime();
  });

  console.log(
    `[competitor-poll] ${due.length}/${dueCreators.length} creators due`,
  );

  for (const creator of due) {
    try {
      await pollCreator(b, creator);
    } catch (err) {
      console.error(`[competitor-poll] error polling creator=${creator.id}:`, err);
    }
  }
}

export async function startCompetitorPollingWorker(): Promise<void> {
  const b = await getBoss();

  await b.schedule(CRON_NAME, CRON_SCHEDULE, {}, { tz: "UTC" });

  await b.work(CRON_NAME, { batchSize: 1 }, async () => {
    await handlePollCron();
  });

  console.log("[competitor-poll] cron scheduled:", CRON_SCHEDULE);
}

export async function stopCompetitorPollingWorker(): Promise<void> {
  if (boss) {
    await boss.unschedule(CRON_NAME);
    await boss.stop();
    boss = null;
  }
}
