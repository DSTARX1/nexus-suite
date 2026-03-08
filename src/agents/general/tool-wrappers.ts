// Diagnostic wrapper for Mastra tool handlers — adapted from pocket-agent pattern.
// Wraps every tool handler with timing, logging, error capture, and safety hooks.

import { validateNoCredentials, stripPII, enforceToolScope } from "./safety";

interface ToolHandlerOptions {
  /** Agent name owning this tool — used for scope enforcement */
  agentName: string;
  /** Tool name — used for scope enforcement + logging */
  toolName: string;
}

interface ToolDiagnostics {
  agentName: string;
  toolName: string;
  durationMs: number;
  inputSize: number;
  outputSize: number;
  error?: string;
}

type ToolHandler<TInput, TOutput> = (input: TInput) => Promise<TOutput>;

// Diagnostic log — in production this would go to structured logging / OpenTelemetry.
// For now, in-memory ring buffer (last 1000 entries) accessible for debugging.
const DIAGNOSTICS_BUFFER_SIZE = 1000;
const diagnosticsBuffer: ToolDiagnostics[] = [];

function pushDiagnostic(entry: ToolDiagnostics): void {
  if (diagnosticsBuffer.length >= DIAGNOSTICS_BUFFER_SIZE) {
    diagnosticsBuffer.shift();
  }
  diagnosticsBuffer.push(entry);
}

/** Read-only access to recent diagnostics (for debugging / admin endpoints). */
export function getRecentDiagnostics(limit = 50): readonly ToolDiagnostics[] {
  return diagnosticsBuffer.slice(-limit);
}

/**
 * Wraps a Mastra tool handler with:
 * 1. Tool scope enforcement (agent allowed to call this tool?)
 * 2. PII stripping on string inputs
 * 3. Timing / input-output size capture
 * 4. Credential leak detection on output
 * 5. Error capture with diagnostics
 */
export function wrapToolHandler<TInput, TOutput>(
  handler: ToolHandler<TInput, TOutput>,
  opts: ToolHandlerOptions,
): ToolHandler<TInput, TOutput> {
  return async (rawInput: TInput): Promise<TOutput> => {
    const start = performance.now();
    const { agentName, toolName } = opts;

    // 1. Scope check
    enforceToolScope(agentName, toolName);

    // 2. PII strip on string inputs
    let input = rawInput;
    if (typeof rawInput === "string") {
      input = stripPII(rawInput) as unknown as TInput;
    } else if (rawInput && typeof rawInput === "object") {
      // Shallow strip: only top-level string fields
      const cleaned = { ...rawInput } as Record<string, unknown>;
      for (const [k, v] of Object.entries(cleaned)) {
        if (typeof v === "string") {
          cleaned[k] = stripPII(v);
        }
      }
      input = cleaned as TInput;
    }

    const inputSize = JSON.stringify(input).length;

    try {
      const output = await handler(input);

      const outputStr = JSON.stringify(output);
      const durationMs = Math.round(performance.now() - start);

      // 4. Credential leak check on output
      if (typeof output === "string") {
        validateNoCredentials(output);
      } else if (outputStr) {
        validateNoCredentials(outputStr);
      }

      pushDiagnostic({
        agentName,
        toolName,
        durationMs,
        inputSize,
        outputSize: outputStr.length,
      });

      return output;
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const errorMsg = err instanceof Error ? err.message : String(err);

      pushDiagnostic({
        agentName,
        toolName,
        durationMs,
        inputSize,
        outputSize: 0,
        error: errorMsg,
      });

      throw err;
    }
  };
}
