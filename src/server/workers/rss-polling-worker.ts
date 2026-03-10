import PgBoss from "pg-boss";
import Parser from "rss-parser";
import { db } from "@/lib/db";

// ── Config ───────────────────────────────────────────────────

const CRON_NAME = "rss:poll";
const CRON_SCHEDULE = "*/15 * * * *"; // every 15 min

const parser = new Parser();

// ── Worker ───────────────────────────────────────────────────

let boss: PgBoss | null = null;

async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss(process.env.DATABASE_URL!);
    await boss.start();
  }
  return boss;
}

// ── Poll single feed ─────────────────────────────────────────

async function pollFeed(feed: {
  id: string;
  url: string;
  organizationId: string;
}): Promise<number> {
  const parsed = await parser.parseURL(feed.url);
  let upserted = 0;

  for (const item of parsed.items) {
    if (!item.link) continue;

    await db.rssArticle.upsert({
      where: { url: item.link },
      create: {
        feedId: feed.id,
        organizationId: feed.organizationId,
        title: item.title ?? "(untitled)",
        url: item.link,
        summary: item.contentSnippet ?? null,
        author: item.creator ?? item.author ?? null,
        publishedAt: item.isoDate ? new Date(item.isoDate) : null,
      },
      update: {},
    });

    upserted++;
  }

  await db.rssFeed.update({
    where: { id: feed.id },
    data: { lastFetchedAt: new Date() },
  });

  return upserted;
}

// ── Cron handler ─────────────────────────────────────────────

async function handlePollCron(): Promise<void> {
  const activeFeeds = await db.rssFeed.findMany({
    where: { isActive: true },
    select: { id: true, url: true, organizationId: true, name: true },
  });

  console.log(`[rss-poll] polling ${activeFeeds.length} active feeds`);

  for (const feed of activeFeeds) {
    try {
      const count = await pollFeed(feed);
      console.log(
        `[rss-poll] feed="${feed.name}" articles=${count}`,
      );
    } catch (err) {
      console.error(`[rss-poll] error polling feed="${feed.name}" id=${feed.id}:`, err);
    }
  }
}

// ── Lifecycle ────────────────────────────────────────────────

export async function startRssPollingWorker(): Promise<void> {
  const b = await getBoss();

  await b.schedule(CRON_NAME, CRON_SCHEDULE, {}, { tz: "UTC" });

  await b.work(CRON_NAME, { batchSize: 1 }, async () => {
    await handlePollCron();
  });

  console.log("[rss-poll] cron scheduled:", CRON_SCHEDULE);
}

export async function stopRssPollingWorker(): Promise<void> {
  if (boss) {
    await boss.unschedule(CRON_NAME);
    await boss.stop();
    boss = null;
  }
}
