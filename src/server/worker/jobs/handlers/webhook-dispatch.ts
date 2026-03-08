import type PgBoss from "pg-boss";
import type { WebhookDispatchJob } from "../types.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export async function handleWebhookDispatch(
  job: PgBoss.Job<WebhookDispatchJob>,
): Promise<void> {
  const { webhookUrl, payload, organizationId } = job.data;

  console.log(
    `[webhook-dispatch] dispatching to ${webhookUrl} org=${organizationId} job=${job.id}`,
  );

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[webhook-dispatch] retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
      await sleep(delay);
    }

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        console.log(`[webhook-dispatch] success status=${res.status} job=${job.id}`);
        return;
      }

      lastError = new Error(`Webhook returned ${res.status}`);
      console.warn(
        `[webhook-dispatch] attempt ${attempt} failed status=${res.status}`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[webhook-dispatch] attempt ${attempt} error: ${lastError.message}`,
      );
    }
  }

  console.error(
    `[webhook-dispatch] exhausted retries for job=${job.id} url=${webhookUrl}`,
  );
  throw lastError ?? new Error("Webhook dispatch failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
