import PgBoss from "pg-boss";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { generate as viralTeardown } from "@/agents/specialists/viral-teardown-agent";
import { generate as scriptAgent } from "@/agents/specialists/script-agent";
import { generate as captionWriter } from "@/agents/specialists/caption-writer";
import { generate as variationOrchestrator } from "@/agents/specialists/variation-orchestrator";
import { sendMediaJob } from "@/server/services/media-queue";
import type { RawAgentContext } from "@/agents/general/types";

// ── Types ─────────────────────────────────────────────────────

interface CompetitorTaskPayload {
  jobType: "analyze" | "reproduce";
  postId: string;
  url: string;
  organizationId: string;
}

interface ScrapeResult {
  taskId: string;
  html: string;
  cookies: Record<string, string>;
  meta: { strategy: string; durationMs: number; url: string };
}

// ── Queues ────────────────────────────────────────────────────

const QUEUE_NAME = "competitor:task";
const SCRAPE_TASK_QUEUE = "scrape:task";
const SCRAPE_RESULT_QUEUE = "scrape:result";

let boss: PgBoss | null = null;

async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss(process.env.DATABASE_URL!);
    await boss.start();
  }
  return boss;
}

// ── Scrape result correlation ─────────────────────────────────

type ScrapeResolver = (result: ScrapeResult) => void;
const pendingScrapes = new Map<string, ScrapeResolver>();

async function startScrapeResultListener(): Promise<void> {
  const b = await getBoss();
  await b.work<ScrapeResult>(
    SCRAPE_RESULT_QUEUE,
    { batchSize: 1 },
    async ([job]) => {
      const result = job.data;
      const resolver = pendingScrapes.get(result.taskId);
      if (resolver) {
        pendingScrapes.delete(result.taskId);
        resolver(result);
      }
    },
  );
}

function waitForScrapeResult(taskId: string, timeoutMs = 120_000): Promise<ScrapeResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingScrapes.delete(taskId);
      reject(new Error(`scrape timeout for taskId=${taskId}`));
    }, timeoutMs);

    pendingScrapes.set(taskId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

// ── Analyze pipeline ──────────────────────────────────────────

async function analyzePost(
  b: PgBoss,
  postId: string,
  url: string,
  organizationId: string,
): Promise<void> {
  const taskId = randomUUID();

  await b.send(SCRAPE_TASK_QUEUE, { taskId, url, organizationId });
  console.log(`[competitor-worker] dispatched scrape:task taskId=${taskId} url=${url}`);

  const scrapeResult = await waitForScrapeResult(taskId);
  console.log(`[competitor-worker] received scrape:result taskId=${taskId} (${scrapeResult.meta.durationMs}ms)`);

  const agentContext: RawAgentContext = {
    organizationId,
    userPrompt: `Analyze the following scraped content from ${url} and produce a viral teardown:\n\n${scrapeResult.html}`,
  };

  const agentResult = await viralTeardown(agentContext.userPrompt, agentContext);

  let analysis: Record<string, unknown>;
  try {
    analysis = JSON.parse(agentResult.text) as Record<string, unknown>;
  } catch {
    analysis = { raw: agentResult.text };
  }

  await db.trackedPost.update({
    where: { id: postId },
    data: {
      analysis: analysis as unknown as Prisma.InputJsonValue,
      analyzedAt: new Date(),
    },
  });

  console.log(`[competitor-worker] analysis saved for postId=${postId}`);
}

// ── Reproduce pipeline ───────────────────────────────────────

async function reproducePost(
  postId: string,
  url: string,
  organizationId: string,
): Promise<void> {
  const post = await db.trackedPost.findUniqueOrThrow({
    where: { id: postId },
    select: { analysis: true, analyzedAt: true },
  });

  if (!post.analyzedAt || !post.analysis) {
    throw new Error(`postId=${postId} not analyzed yet — run analyze first`);
  }

  const analysisJson = JSON.stringify(post.analysis);
  const baseContext: RawAgentContext = { organizationId, userPrompt: "" };

  // 1. Script agent
  const scriptResult = await scriptAgent(
    `Write a video script based on this viral teardown analysis:\n\n${analysisJson}`,
    { ...baseContext, userPrompt: "Generate script from analysis" },
  );
  console.log(`[competitor-worker] script-agent done for postId=${postId}`);

  // 2. Caption writer
  const captionResult = await captionWriter(
    `Write a caption for this script and analysis:\n\nScript: ${scriptResult.text}\n\nAnalysis: ${analysisJson}`,
    { ...baseContext, userPrompt: "Generate caption from script + analysis" },
  );
  console.log(`[competitor-worker] caption-writer done for postId=${postId}`);

  // 3. Variation orchestrator → FFmpeg transforms
  const variationResult = await variationOrchestrator(
    `Generate FFmpeg transform variations for this script:\n\n${scriptResult.text}`,
    { ...baseContext, userPrompt: "Generate FFmpeg transforms from script" },
  );
  console.log(`[competitor-worker] variation-orchestrator done for postId=${postId}`);

  let transforms: Record<string, unknown>;
  try {
    transforms = JSON.parse(variationResult.text) as Record<string, unknown>;
  } catch {
    transforms = { raw: variationResult.text };
  }

  // 4. Queue media:task
  await sendMediaJob({
    type: "transform",
    organizationId,
    sourceUrl: url,
    transforms,
  });
  console.log(`[competitor-worker] media:task queued for postId=${postId}`);

  // 5. Mark reproduced
  await db.trackedPost.update({
    where: { id: postId },
    data: { reproduced: true },
  });

  console.log(`[competitor-worker] reproduce complete for postId=${postId}`);
}

// ── Worker ────────────────────────────────────────────────────

export async function startCompetitorWorker(): Promise<void> {
  const b = await getBoss();

  await startScrapeResultListener();

  await b.work<CompetitorTaskPayload>(
    QUEUE_NAME,
    { batchSize: 1 },
    async ([job]) => {
      const { jobType, postId, url, organizationId } = job.data;

      console.log(
        `[competitor-worker] received ${jobType} job — postId=${postId} url=${url} org=${organizationId}`,
      );

      switch (jobType) {
        case "analyze":
          await analyzePost(b, postId, url, organizationId);
          break;
        case "reproduce":
          await reproducePost(postId, url, organizationId);
          break;
      }
    },
  );

  console.log("[competitor-worker] listening on queue:", QUEUE_NAME);
}

export async function stopCompetitorWorker(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
  }
}
