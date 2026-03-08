import PgBoss from "pg-boss";

// ── pg-boss singleton ────────────────────────────────────────────

let bossInstance: PgBoss | null = null;

async function getBoss(): Promise<PgBoss> {
  if (!bossInstance) {
    bossInstance = new PgBoss(process.env.DATABASE_URL!);
    await bossInstance.start();
  }
  return bossInstance;
}

// ── Types (mirror consumer's MediaJob) ───────────────────────────

export interface MediaJob {
  type: "download" | "transform";
  organizationId: string;
  sourceUrl?: string;
  localPath?: string;
  outputKey?: string;
  transforms?: Record<string, unknown>;
}

// ── Sender ───────────────────────────────────────────────────────

const QUEUE_NAME = "media:task";

export async function sendMediaJob(
  payload: MediaJob,
  options?: PgBoss.SendOptions,
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(QUEUE_NAME, payload, options ?? {});
}
