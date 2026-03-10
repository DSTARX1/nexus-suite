-- AlterEnum
BEGIN;
CREATE TYPE "PostStatus_new" AS ENUM ('SCHEDULED', 'POSTING', 'SUCCESS', 'FAILED', 'SKIPPED');
ALTER TABLE "public"."PostRecord" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PostRecord" ALTER COLUMN "status" TYPE "PostStatus_new" USING ("status"::text::"PostStatus_new");
ALTER TYPE "PostStatus" RENAME TO "PostStatus_old";
ALTER TYPE "PostStatus_new" RENAME TO "PostStatus";
DROP TYPE "public"."PostStatus_old";
ALTER TABLE "PostRecord" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';
COMMIT;

-- DropIndex
DROP INDEX "PostRecord_accountId_idx";

-- DropIndex
DROP INDEX "PostRecord_variationId_idx";

-- AlterTable
ALTER TABLE "PostRecord" ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "SourceVideo" ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "duration" SET DATA TYPE INTEGER;

-- AlterTable
ALTER TABLE "VideoVariation" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "fileHash" DROP NOT NULL,
ALTER COLUMN "pHash" DROP NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending';

-- CreateTable
CREATE TABLE "TrackedCreator" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "username" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "autoReproduce" BOOLEAN NOT NULL DEFAULT false,
    "outlierThreshold" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "pollInterval" INTEGER NOT NULL DEFAULT 3600,
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedCreator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedPost" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT,
    "url" TEXT,
    "thumbnailUrl" TEXT,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "isOutlier" BOOLEAN NOT NULL DEFAULT false,
    "outlierScore" DOUBLE PRECISION,
    "reproduced" BOOLEAN NOT NULL DEFAULT false,
    "analysis" JSONB,
    "analyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostSnapshot" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RssFeed" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RssFeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RssArticle" (
    "id" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "summary" TEXT,
    "author" TEXT,
    "publishedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RssArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedHashtag" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "tag" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedHashtag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedCreator_organizationId_idx" ON "TrackedCreator"("organizationId");

-- CreateIndex
CREATE INDEX "TrackedCreator_isActive_lastPolledAt_idx" ON "TrackedCreator"("isActive", "lastPolledAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedCreator_organizationId_platform_username_key" ON "TrackedCreator"("organizationId", "platform", "username");

-- CreateIndex
CREATE INDEX "TrackedPost_creatorId_idx" ON "TrackedPost"("creatorId");

-- CreateIndex
CREATE INDEX "TrackedPost_isOutlier_idx" ON "TrackedPost"("isOutlier");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedPost_creatorId_externalId_key" ON "TrackedPost"("creatorId", "externalId");

-- CreateIndex
CREATE INDEX "PostSnapshot_postId_capturedAt_idx" ON "PostSnapshot"("postId", "capturedAt");

-- CreateIndex
CREATE INDEX "RssFeed_organizationId_idx" ON "RssFeed"("organizationId");

-- CreateIndex
CREATE INDEX "RssFeed_isActive_idx" ON "RssFeed"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RssFeed_organizationId_url_key" ON "RssFeed"("organizationId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "RssArticle_url_key" ON "RssArticle"("url");

-- CreateIndex
CREATE INDEX "RssArticle_feedId_idx" ON "RssArticle"("feedId");

-- CreateIndex
CREATE INDEX "RssArticle_organizationId_idx" ON "RssArticle"("organizationId");

-- CreateIndex
CREATE INDEX "RssArticle_publishedAt_idx" ON "RssArticle"("publishedAt");

-- CreateIndex
CREATE INDEX "TrackedHashtag_organizationId_idx" ON "TrackedHashtag"("organizationId");

-- CreateIndex
CREATE INDEX "TrackedHashtag_isActive_idx" ON "TrackedHashtag"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedHashtag_organizationId_platform_tag_key" ON "TrackedHashtag"("organizationId", "platform", "tag");

-- CreateIndex
CREATE INDEX "PostRecord_organizationId_status_idx" ON "PostRecord"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PostRecord_accountId_scheduledAt_idx" ON "PostRecord"("accountId", "scheduledAt");

-- AddForeignKey
ALTER TABLE "TrackedCreator" ADD CONSTRAINT "TrackedCreator_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedPost" ADD CONSTRAINT "TrackedPost_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "TrackedCreator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSnapshot" ADD CONSTRAINT "PostSnapshot_postId_fkey" FOREIGN KEY ("postId") REFERENCES "TrackedPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostRecord" ADD CONSTRAINT "PostRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RssFeed" ADD CONSTRAINT "RssFeed_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RssArticle" ADD CONSTRAINT "RssArticle_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "RssFeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedHashtag" ADD CONSTRAINT "TrackedHashtag_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

