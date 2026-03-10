import { PrismaClient } from "@prisma/client";

const ORG_SLUG = "saraiknowsball";

/**
 * Seed the saraiknowsball organization with all monitored sources:
 * - TrackedCreators: X (4), TikTok (5), IG (1)
 * - RssFeeds: ESPN NBA, ESPN NFL, NBA.com, Bleacher Report
 * - TrackedHashtags: basketball, NBA, NBAhighlights, hoops, balltok (all TikTok)
 */
export async function seedSaraiknowsball(prisma: PrismaClient) {
  console.log(`[seed] Upserting organization: ${ORG_SLUG}`);

  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: {
      name: "Sarai Knows Ball",
      slug: ORG_SLUG,
      subscriptionStatus: "ACTIVE",
      onboardingStatus: "ACTIVE",
      pricingTier: "PRO",
      maxAccounts: 3,
      maxWorkflowRuns: 50,
      maxVideosPerMonth: 30,
      mlFeaturesEnabled: false,
      multiplierEnabled: false,
      dailyLlmBudgetCents: 500,
      brandConfig: {
        niche: "sports",
        voice: "energetic, opinionated, Gen-Z sports fan",
        platforms: ["TIKTOK", "INSTAGRAM", "X"],
      },
    },
  });

  console.log(`[seed] Organization created: ${org.id}`);

  // ── Tracked Creators ────────────────────────────────────────────

  const creators = [
    // X (Twitter) creators
    { platform: "X" as const, username: "AdamSchefter", profileUrl: "https://x.com/AdamSchefter" },
    { platform: "X" as const, username: "NFL", profileUrl: "https://x.com/NFL" },
    { platform: "X" as const, username: "MLB", profileUrl: "https://x.com/MLB" },
    { platform: "X" as const, username: "NHL", profileUrl: "https://x.com/NHL" },
    // TikTok creators
    { platform: "TIKTOK" as const, username: "bleacherreport", profileUrl: "https://www.tiktok.com/@bleacherreport" },
    { platform: "TIKTOK" as const, username: "espn", profileUrl: "https://www.tiktok.com/@espn" },
    { platform: "TIKTOK" as const, username: "sportscenter", profileUrl: "https://www.tiktok.com/@sportscenter" },
    { platform: "TIKTOK" as const, username: "nba", profileUrl: "https://www.tiktok.com/@nba" },
    { platform: "TIKTOK" as const, username: "overtime", profileUrl: "https://www.tiktok.com/@overtime" },
    // Instagram creators
    { platform: "INSTAGRAM" as const, username: "sportscenter", profileUrl: "https://www.instagram.com/sportscenter" },
  ];

  for (const creator of creators) {
    await prisma.trackedCreator.upsert({
      where: {
        organizationId_platform_username: {
          organizationId: org.id,
          platform: creator.platform,
          username: creator.username,
        },
      },
      update: {},
      create: {
        organizationId: org.id,
        platform: creator.platform,
        username: creator.username,
        profileUrl: creator.profileUrl,
        isActive: true,
        autoReproduce: false,
        outlierThreshold: 3.0,
        pollInterval: 3600,
      },
    });
  }

  console.log(`[seed] Upserted ${creators.length} tracked creators`);

  // ── RSS Feeds ───────────────────────────────────────────────────

  const feeds = [
    { name: "ESPN NBA", url: "https://www.espn.com/espn/rss/nba/news" },
    { name: "ESPN NFL", url: "https://www.espn.com/espn/rss/nfl/news" },
    { name: "NBA.com News", url: "https://www.nba.com/news/rss" },
    { name: "Bleacher Report", url: "https://bleacherreport.com/articles/feed" },
  ];

  for (const feed of feeds) {
    await prisma.rssFeed.upsert({
      where: {
        organizationId_url: {
          organizationId: org.id,
          url: feed.url,
        },
      },
      update: {},
      create: {
        organizationId: org.id,
        name: feed.name,
        url: feed.url,
        isActive: true,
      },
    });
  }

  console.log(`[seed] Upserted ${feeds.length} RSS feeds`);

  // ── Tracked Hashtags ────────────────────────────────────────────

  const hashtags = [
    { platform: "TIKTOK" as const, tag: "basketball" },
    { platform: "TIKTOK" as const, tag: "NBA" },
    { platform: "TIKTOK" as const, tag: "NBAhighlights" },
    { platform: "TIKTOK" as const, tag: "hoops" },
    { platform: "TIKTOK" as const, tag: "balltok" },
  ];

  for (const hashtag of hashtags) {
    await prisma.trackedHashtag.upsert({
      where: {
        organizationId_platform_tag: {
          organizationId: org.id,
          platform: hashtag.platform,
          tag: hashtag.tag,
        },
      },
      update: {},
      create: {
        organizationId: org.id,
        platform: hashtag.platform,
        tag: hashtag.tag,
        isActive: true,
      },
    });
  }

  console.log(`[seed] Upserted ${hashtags.length} tracked hashtags`);
  console.log(`[seed] ✅ saraiknowsball seed complete`);

  return org;
}
