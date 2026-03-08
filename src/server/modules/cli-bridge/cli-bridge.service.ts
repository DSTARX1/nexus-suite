import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fetchSecret } from "@/lib/infisical";

const execFileAsync = promisify(execFile);

const POCKET_CLI_PATH =
  process.env.POCKET_CLI_PATH ?? "/usr/local/bin/pocket-agent-cli";

const INFISICAL_PROJECT_ID = process.env.INFISICAL_PROJECT_ID ?? "";
const INFISICAL_ENVIRONMENT = process.env.INFISICAL_ENVIRONMENT ?? "prod";

export interface CliResult {
  success: boolean;
  data: unknown;
  stderr: string;
}

/**
 * Spawn pocket-agent-cli with JSON output and parse the result.
 * No shell involved — uses execFile directly to prevent injection.
 */
export async function execPocketCli(
  domain: string,
  service: string,
  action: string,
  args: Record<string, string> = {},
): Promise<CliResult> {
  const cliArgs = [domain, service, action, "--output", "json"];
  for (const [key, value] of Object.entries(args)) {
    cliArgs.push(`--${key}`, value);
  }

  const { stdout, stderr } = await execFileAsync(POCKET_CLI_PATH, cliArgs, {
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });

  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = stdout;
  }

  return { success: true, data, stderr };
}

/**
 * Execute CLI with per-org credential bridging.
 * Fetches tokens from Infisical, writes temp pocket config, executes, cleans up.
 * Credential vars nulled out in finally block — fetch-use-discard pattern.
 */
export async function execPocketCliWithCredentials(
  organizationId: string,
  infisicalSecretPath: string,
  domain: string,
  service: string,
  action: string,
  args: Record<string, string> = {},
  infisicalProxyPath?: string | null,
): Promise<CliResult> {
  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  let proxyUrl: string | null = null;
  const tempConfigPath = join(tmpdir(), `pocket-${randomUUID()}.json`);

  try {
    // Fetch credentials from Infisical
    accessToken = await fetchSecret(
      INFISICAL_PROJECT_ID,
      INFISICAL_ENVIRONMENT,
      infisicalSecretPath,
      "ACCESS_TOKEN",
    );
    refreshToken = await fetchSecret(
      INFISICAL_PROJECT_ID,
      INFISICAL_ENVIRONMENT,
      infisicalSecretPath,
      "REFRESH_TOKEN",
    );

    if (infisicalProxyPath) {
      proxyUrl = await fetchSecret(
        INFISICAL_PROJECT_ID,
        INFISICAL_ENVIRONMENT,
        infisicalProxyPath,
        "PROXY_URL",
      );
    }

    // Write temp config for the CLI
    const config: Record<string, unknown> = {
      organizationId,
      accessToken,
      refreshToken,
      ...(proxyUrl ? { proxyUrl } : {}),
    };

    await writeFile(tempConfigPath, JSON.stringify(config), {
      mode: 0o600, // owner read/write only
    });

    // Execute CLI with config path
    return await execPocketCli(domain, service, action, {
      ...args,
      config: tempConfigPath,
    });
  } finally {
    // Cleanup: remove temp file, discard creds from memory
    accessToken = null;
    refreshToken = null;
    proxyUrl = null;

    try {
      await unlink(tempConfigPath);
    } catch {
      // File may not exist if write failed — ignore
    }
  }
}
