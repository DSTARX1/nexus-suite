#!/usr/bin/env tsx
import { Command } from "commander";
import { provision } from "./commands/provision";
import { assignProxy } from "./commands/assign-proxy";
import { generateWorkflows } from "./commands/generate-workflows";

const program = new Command();

program
  .name("nexus-admin")
  .description("Nexus CLI provisioning suite")
  .version("0.1.0");

program
  .command("provision")
  .description("Provision a new org: generate burner profiles, proxy configs, directory structure")
  .argument("<orgId>", "Organization ID")
  .option("--burners <count>", "Number of burner accounts to generate", "5")
  .action(async (orgId: string, opts: { burners: string }) => {
    await provision(orgId, parseInt(opts.burners, 10));
  });

program
  .command("assign-proxy")
  .description("Assign a residential proxy to a platform account via Infisical")
  .argument("<accountId>", "OrgPlatformToken ID")
  .argument("<proxyUrl>", "Proxy URL (e.g., socks5://user:pass@ip:port)")
  .action(async (accountId: string, proxyUrl: string) => {
    await assignProxy(accountId, proxyUrl);
  });

program
  .command("generate-workflows")
  .description("Scaffold custom YAML workflows + brand prompt for an org")
  .argument("<orgId>", "Organization ID")
  .option("--niche <niche>", "Content niche override (defaults to onboarding submission)")
  .action(async (orgId: string, opts: { niche?: string }) => {
    await generateWorkflows(orgId, opts.niche);
  });

program.parse();
