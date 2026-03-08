import { createTool } from "@mastra/core";
import { z } from "zod";
import { execPocketCli } from "@/server/modules/cli-bridge/cli-bridge.service";

const MAX_LOG_SIZE = 2048;

function truncate(value: unknown): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.length > MAX_LOG_SIZE
    ? str.slice(0, MAX_LOG_SIZE) + `…[${str.length - MAX_LOG_SIZE} truncated]`
    : str;
}

interface ToolMeta {
  domain: string;
  service: string;
  action: string;
  description: string;
  inputSchema: z.ZodObject<Record<string, z.ZodTypeAny>>;
}

export interface WrappedToolResult {
  success: boolean;
  data: unknown;
  durationMs: number;
  error?: { name: string; message: string; stack?: string };
}

/**
 * Wrap a CLI bridge call as a Mastra tool with timing, error capture, and size logging.
 */
export function wrapToolHandler(meta: ToolMeta) {
  return createTool({
    id: `pocket_${meta.domain}_${meta.service}_${meta.action}`,
    description: meta.description,
    inputSchema: meta.inputSchema,
    execute: async ({ context }): Promise<WrappedToolResult> => {
      const start = performance.now();
      const inputArgs: Record<string, string> = {};
      for (const [k, v] of Object.entries(context as Record<string, unknown>)) {
        inputArgs[k] = String(v);
      }

      console.log(
        `[tool:${meta.domain}/${meta.service}/${meta.action}] input=${truncate(inputArgs)}`,
      );

      try {
        const result = await execPocketCli(
          meta.domain,
          meta.service,
          meta.action,
          inputArgs,
        );
        const durationMs = Math.round(performance.now() - start);

        console.log(
          `[tool:${meta.domain}/${meta.service}/${meta.action}] ok duration=${durationMs}ms output=${truncate(result.data)}`,
        );

        return { success: true, data: result.data, durationMs };
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        const error =
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : { name: "UnknownError", message: String(err) };

        console.error(
          `[tool:${meta.domain}/${meta.service}/${meta.action}] error duration=${durationMs}ms ${error.message}`,
        );

        return { success: false, data: null, durationMs, error };
      }
    },
  });
}

// ── Pre-built tool definitions ───────────────────────────────────
// Add concrete tools here as the CLI surface expands

export const socialPostTool = wrapToolHandler({
  domain: "social",
  service: "post",
  action: "create",
  description: "Create a social media post via pocket-agent-cli",
  inputSchema: z.object({
    platform: z.string().describe("Target platform (twitter, instagram, etc.)"),
    content: z.string().describe("Post content text"),
    mediaUrl: z.string().optional().describe("Optional media attachment URL"),
  }),
});

export const socialAnalyticsTool = wrapToolHandler({
  domain: "social",
  service: "analytics",
  action: "fetch",
  description: "Fetch social media analytics via pocket-agent-cli",
  inputSchema: z.object({
    platform: z.string().describe("Target platform"),
    metric: z.string().describe("Metric to fetch (engagement, reach, etc.)"),
    period: z.string().optional().describe("Time period (7d, 30d, etc.)"),
  }),
});
