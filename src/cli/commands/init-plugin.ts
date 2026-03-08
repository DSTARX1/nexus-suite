import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { db } from "@/lib/db";

const TEMPLATE = `import type { RawAgentContext } from "@/agents/general/types";

const AGENT_NAME = "__AGENT_NAME__";

const INSTRUCTIONS = \`You are a custom client plugin agent.

Describe this agent's single responsibility here.
\`;

export function createAgent() {
  return { name: AGENT_NAME, instructions: INSTRUCTIONS };
}

export async function generate(
  prompt: string,
  opts?: { model?: string; maxTokens?: number },
) {
  // Client plugins receive a sandboxed context (organizationId + input only).
  // No Infisical access, no variables, no config.

  return {
    text: \`[\${AGENT_NAME}] Not yet implemented. Prompt: \${prompt}\`,
    usage: undefined,
    toolCalls: undefined,
  };
}
`;

export async function initPlugin(orgId: string, agentName: string) {
  console.log(`\n  Initializing plugin: ${agentName} for org ${orgId}\n`);

  // 1. Validate org exists
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true },
  });

  if (!org) {
    console.error(`  ERROR: Organization ${orgId} not found`);
    process.exit(1);
  }

  // 2. Create directory
  const agentsDir = resolve(
    process.cwd(),
    "src/agents/clients",
    orgId,
    "agents",
  );

  mkdirSync(agentsDir, { recursive: true });

  // 3. Write template
  const filePath = join(agentsDir, `${agentName}.ts`);

  if (existsSync(filePath)) {
    console.error(`  ERROR: Plugin already exists at ${filePath}`);
    process.exit(1);
  }

  const content = TEMPLATE.replace(/__AGENT_NAME__/g, agentName);
  writeFileSync(filePath, content, "utf-8");

  console.log(`  Organization: ${org.name} (${org.id})`);
  console.log(`  Created: ${filePath}`);
  console.log(`\n  Next steps:`);
  console.log(`    1. Edit ${filePath} — add instructions + tools`);
  console.log(`    2. The plugin auto-loads via resolveAgent() at runtime`);
  console.log(`    3. Sandboxed: only organizationId + input are accessible\n`);
}
