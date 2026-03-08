import type { Redis } from "ioredis";

export type ProgressEvent =
  | "started"
  | `strategy:${string}`
  | "captcha:solving"
  | "success"
  | "failed";

/**
 * Publishes scrape progress events to a Redis pub/sub channel
 * so consumers (nexus-worker) can subscribe for real-time updates.
 */
export class ProgressStream {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private channel(taskId: string): string {
    return `scrape:stream:${taskId}`;
  }

  async publish(taskId: string, event: ProgressEvent, meta?: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify({ event, ts: Date.now(), ...meta });
    await this.redis.publish(this.channel(taskId), payload);
  }

  async started(taskId: string): Promise<void> {
    await this.publish(taskId, "started");
  }

  async strategy(taskId: string, name: string): Promise<void> {
    await this.publish(taskId, `strategy:${name}`);
  }

  async captchaSolving(taskId: string): Promise<void> {
    await this.publish(taskId, "captcha:solving");
  }

  async success(taskId: string): Promise<void> {
    await this.publish(taskId, "success");
  }

  async failed(taskId: string, error: string): Promise<void> {
    await this.publish(taskId, "failed", { error });
  }
}
