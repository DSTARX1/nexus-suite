import { Redis } from "ioredis";

// ── SSE Event Types ──────────────────────────────────────────────
export type SSEEventType =
  | "workflow_status"
  | "post_status"
  | "budget_warning"
  | "outlier_detected"
  | "account_health";

export interface SSEEvent {
  type: SSEEventType;
  data: Record<string, unknown>;
  timestamp: number;
}

// ── Redis Pub/Sub Broadcaster ────────────────────────────────────
// Separate Redis connections for pub and sub (ioredis requirement:
// a client in subscriber mode cannot issue other commands).

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379/0";

function channelKey(orgId: string): string {
  return `sse:org:${orgId}`;
}

// Publisher — shared singleton
let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(redisUrl);
  }
  return publisher;
}

/**
 * Publish an SSE event to all listeners for an org.
 * Called from workflow executor, post publisher, budget checker, etc.
 */
export async function publishSSE(
  orgId: string,
  type: SSEEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const event: SSEEvent = { type, data, timestamp: Date.now() };
  await getPublisher().publish(channelKey(orgId), JSON.stringify(event));
}

/**
 * Subscribe to an org's SSE channel.
 * Returns { stream, cleanup } — stream is a ReadableStream for the Response.
 * Caller must invoke cleanup() when the client disconnects.
 */
export function subscribeSSE(orgId: string): {
  stream: ReadableStream<Uint8Array>;
  cleanup: () => void;
} {
  const subscriber = new Redis(redisUrl);
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  // Heartbeat to keep connection alive (every 30s)
  const heartbeat = setInterval(() => {
    if (controllerRef && !closed) {
      try {
        controllerRef.enqueue(encoder.encode(": heartbeat\n\n"));
      } catch {
        // stream already closed
      }
    }
  }, 30_000);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;

      subscriber.subscribe(channelKey(orgId));

      subscriber.on("message", (_channel: string, message: string) => {
        if (closed) return;
        try {
          const event: SSEEvent = JSON.parse(message);
          const payload =
            `event: ${event.type}\n` +
            `data: ${JSON.stringify(event.data)}\n` +
            `id: ${event.timestamp}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // malformed message — skip
        }
      });
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
      subscriber.unsubscribe();
      subscriber.quit();
    },
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    subscriber.unsubscribe();
    subscriber.quit();
    try {
      controllerRef?.close();
    } catch {
      // already closed
    }
  };

  return { stream, cleanup };
}
