import PgBoss from "pg-boss";
import { uploadToR2 } from "./r2.js";
import { download } from "./download.js";
import { runPipeline, runRaw } from "./ffmpeg.js";
import { ensureAudioSafe, type AudioAnalysis } from "./audio-safety.js";
import type { TransformConfig, TransformFragment } from "./transforms.js";

const QUEUE_NAME = "media:task";

export interface MediaJob {
  type: "download" | "transform" | "audio-check";
  organizationId: string;
  sourceUrl?: string;
  localPath?: string;
  outputKey?: string;
  transforms?: TransformConfig | TransformFragment;
}

export interface MediaJobResult {
  success: boolean;
  r2Key?: string;
  error?: string;
  audioAnalysis?: AudioAnalysis;
  audioStripped?: boolean;
}

async function handleDownload(job: MediaJob): Promise<MediaJobResult> {
  const { sourceUrl, outputKey } = job;
  if (!sourceUrl) {
    return { success: false, error: "sourceUrl required for download job" };
  }

  const result = await download({ url: sourceUrl });
  const upload = await uploadToR2(result.localPath, outputKey);
  return { success: true, r2Key: upload.key };
}

async function handleTransform(job: MediaJob): Promise<MediaJobResult> {
  const { localPath, outputKey, transforms } = job;
  if (!localPath) {
    return { success: false, error: "localPath required for transform job" };
  }

  // Support both TransformConfig (layer options) and raw TransformFragment
  const isFragment = transforms && "videoFilters" in transforms;
  const result = isFragment
    ? await runRaw(localPath, transforms as TransformFragment)
    : await runPipeline(localPath, transforms as TransformConfig | undefined);

  const upload = await uploadToR2(result.outputPath, outputKey);
  return { success: true, r2Key: upload.key };
}

async function handleAudioCheck(job: MediaJob): Promise<MediaJobResult> {
  const { localPath, outputKey } = job;
  if (!localPath) {
    return { success: false, error: "localPath required for audio-check job" };
  }

  const result = await ensureAudioSafe(localPath);
  let r2Key: string | undefined;

  if (result.audioStripped && outputKey) {
    const upload = await uploadToR2(result.outputPath, outputKey);
    r2Key = upload.key;
  }

  return {
    success: true,
    r2Key,
    audioAnalysis: result.analysis,
    audioStripped: result.audioStripped,
  };
}

async function processJob(job: MediaJob): Promise<MediaJobResult> {
  switch (job.type) {
    case "download":
      return handleDownload(job);
    case "transform":
      return handleTransform(job);
    case "audio-check":
      return handleAudioCheck(job);
    default:
      return { success: false, error: `unknown job type: ${(job as MediaJob).type}` };
  }
}

export async function startConsumer(): Promise<PgBoss> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for pg-boss");
  }

  const boss = new PgBoss({ connectionString });

  boss.on("error", (err) => console.error("[pg-boss] error:", err));

  await boss.start();
  console.log(`[pg-boss] started, subscribing to ${QUEUE_NAME}`);

  await boss.work<MediaJob>(QUEUE_NAME, async (jobs) => {
    for (const job of jobs) {
      console.log(`[media:task] processing job ${job.id} type=${job.data.type}`);
      const result = await processJob(job.data);

      if (!result.success) {
        console.error(`[media:task] job ${job.id} failed: ${result.error}`);
        throw new Error(result.error);
      }

      console.log(`[media:task] job ${job.id} complete, r2Key=${result.r2Key}`);
    }
  });

  return boss;
}
