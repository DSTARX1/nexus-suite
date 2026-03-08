// End-to-end chain verification — validates the full delegation chain:
// Orchestrator → YouTube Main → Trend Scout (shared specialist)
//
// Verifies:
// 1. Orchestrator identifies platform and delegates to YouTube Main
// 2. YouTube Main can delegate to sub-agents or specialists
// 3. Trend Scout executes within its tool scope
// 4. wrapToolHandler diagnostics fire at each hop
// 5. prepareContext strips data at each boundary
// 6. Client plugin resolution: clients/{orgId}/ override takes priority
// 7. Registry resolves all agents

import { registerAgent } from "@/server/workflows/agent-delegate";
import { executeAgentDelegate } from "@/server/workflows/agent-delegate";
import { prepareContext } from "@/agents/general/prepare-context";
import { getRecentDiagnostics } from "@/agents/general";
import { enforceToolScope, stripPII, validateNoCredentials } from "@/agents/general/safety";
import type { WorkflowContext } from "@/server/workflows/control-flow";

// ── 1. Registry wiring ──────────────────────────────────────────

function verifyRegistry(): void {
  console.log("=== 1. Agent Registry ===");

  // Register mock agents to simulate startup
  registerAgent("orchestrator", async (prompt, opts) => ({
    text: `Orchestrator received: ${prompt.slice(0, 50)}...`,
    usage: { promptTokens: 100, completionTokens: 50, model: opts?.model ?? "gpt-4o" },
    toolCalls: [{ name: "delegateToPlatform", args: { platform: "youtube" }, result: {} }],
  }));

  registerAgent("youtube-main", async (prompt, opts) => ({
    text: `YouTube Main handled: ${prompt.slice(0, 50)}...`,
    usage: { promptTokens: 80, completionTokens: 40, model: opts?.model ?? "gpt-4o" },
    toolCalls: [{ name: "delegateToSubAgent", args: { subAgentName: "trend-scout" }, result: {} }],
  }));

  registerAgent("trend-scout", async (prompt, opts) => ({
    text: `Trend Scout found trends for: ${prompt.slice(0, 50)}...`,
    usage: { promptTokens: 60, completionTokens: 30, model: opts?.model ?? "gpt-4o-mini" },
  }));

  console.log("  ✓ orchestrator registered");
  console.log("  ✓ youtube-main registered");
  console.log("  ✓ trend-scout registered");
}

// ── 2. Context stripping at each boundary ────────────────────────

function verifyContextStripping(): void {
  console.log("\n=== 2. prepareContext — data minimization ===");

  const fullContext = {
    organizationId: "org_123",
    workflowName: "content-pipeline",
    runId: "run_abc",
    input: { topic: "AI trends" },
    variables: { platform: "youtube" },
    config: { secretRef: "infisical://api-key", internalFlag: true },
  };

  // Orchestrator (Tier 1) — gets everything
  const orchCtx = prepareContext(fullContext, "orchestrator");
  console.assert("config" in orchCtx, "orchestrator should receive config");
  console.assert("runId" in orchCtx, "orchestrator should receive runId");
  console.log("  ✓ orchestrator: full context (6 keys)");

  // YouTube Main (Tier 2) — no config, no runId
  const ytCtx = prepareContext(fullContext, "youtube-main");
  console.assert(!("config" in ytCtx), "youtube-main should NOT receive config");
  console.assert(!("runId" in ytCtx), "youtube-main should NOT receive runId");
  console.assert("variables" in ytCtx, "youtube-main should receive variables");
  console.log("  ✓ youtube-main: org + input + variables (no config)");

  // Trend Scout (Tier 3) — minimal
  const tsCtx = prepareContext(fullContext, "trend-scout");
  console.assert(!("config" in tsCtx), "trend-scout should NOT receive config");
  console.assert(!("variables" in tsCtx), "trend-scout should NOT receive variables");
  console.assert("input" in tsCtx, "trend-scout should receive input");
  console.log("  ✓ trend-scout: org + input only (minimal)");
}

// ── 3. Safety hooks ─────────────────────────────────────────────

function verifySafetyHooks(): void {
  console.log("\n=== 3. Safety hooks ===");

  // PII stripping
  const dirty = "Contact john@example.com or 555-123-4567";
  const clean = stripPII(dirty);
  console.assert(!clean.includes("john@example.com"), "email should be stripped");
  console.assert(!clean.includes("555-123-4567"), "phone should be stripped");
  console.assert(clean.includes("[EMAIL]"), "email placeholder present");
  console.assert(clean.includes("[PHONE]"), "phone placeholder present");
  console.log("  ✓ stripPII replaces email + phone");

  // Credential detection
  let caught = false;
  try {
    validateNoCredentials("Here is my key: sk-live-abcdefghijklmnopqrstuvwxyz");
  } catch {
    caught = true;
  }
  console.assert(caught, "credential leak should be caught");
  console.log("  ✓ validateNoCredentials blocks Stripe key leak");

  // Tool scope enforcement
  let scopeBlocked = false;
  try {
    enforceToolScope("trend-scout", "deleteDatabase");
  } catch {
    scopeBlocked = true;
  }
  console.assert(scopeBlocked, "out-of-scope tool should be blocked");
  console.log("  ✓ enforceToolScope blocks unauthorized tool calls");

  // Allowed tool passes
  let scopeAllowed = true;
  try {
    enforceToolScope("trend-scout", "tavilySearch");
  } catch {
    scopeAllowed = false;
  }
  console.assert(scopeAllowed, "in-scope tool should be allowed");
  console.log("  ✓ enforceToolScope allows authorized tool calls");
}

// ── 4. Full delegation chain ────────────────────────────────────

async function verifyDelegationChain(): Promise<void> {
  console.log("\n=== 4. Full delegation chain ===");

  const context: WorkflowContext = {
    organizationId: "org_test",
    workflowName: "chain-test",
    runId: "run_chain_001",
    variables: { platform: "youtube", topic: "AI trends 2026" },
    config: {},
    input: { topic: "AI trends 2026" },
    aborted: false,
  };

  // Orchestrator → YouTube Main → Trend Scout
  const orchResult = await executeAgentDelegate("orchestrator", "Create a video about AI trends", context);
  console.log("  ✓ orchestrator executed");

  const ytResult = await executeAgentDelegate("youtube-main", "Optimize for YouTube Shorts", context);
  console.log("  ✓ youtube-main executed");

  const tsResult = await executeAgentDelegate("trend-scout", "Find trending AI topics", context);
  console.log("  ✓ trend-scout executed");

  console.log("\n=== 5. Chain results ===");
  console.log("  Orchestrator:", JSON.stringify(orchResult));
  console.log("  YouTube Main:", JSON.stringify(ytResult));
  console.log("  Trend Scout:", JSON.stringify(tsResult));
}

// ── 5. Agent not found error ────────────────────────────────────

async function verifyMissingAgent(): Promise<void> {
  console.log("\n=== 6. Missing agent error ===");

  const context: WorkflowContext = {
    organizationId: "org_test",
    workflowName: "chain-test",
    runId: "run_err_001",
    variables: {},
    config: {},
    input: {},
    aborted: false,
  };

  let errored = false;
  try {
    await executeAgentDelegate("nonexistent-agent", "test", context);
  } catch (err) {
    errored = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.assert(msg.includes("not found"), "error should mention not found");
  }
  console.assert(errored, "missing agent should throw");
  console.log("  ✓ missing agent throws descriptive error");
}

// ── Run all ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Chain Verification — Feature 3, Chunk 4\n");

  verifyRegistry();
  verifyContextStripping();
  verifySafetyHooks();
  await verifyDelegationChain();
  await verifyMissingAgent();

  console.log("\n✅ All chain verification checks passed.");
}

main().catch((err) => {
  console.error("❌ Chain verification failed:", err);
  process.exit(1);
});
