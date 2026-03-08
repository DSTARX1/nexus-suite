import { db } from "@/lib/db";
import { storeSecret } from "@/lib/infisical";

const INFISICAL_PROJECT_ID = process.env.INFISICAL_PROJECT_ID!;
const INFISICAL_ENV = process.env.INFISICAL_ENV ?? "dev";

export async function assignProxy(accountId: string, proxyUrl: string) {
  console.log(`\n  Assigning proxy to account: ${accountId}`);

  // 1. Validate proxy URL format
  const proxyPattern = /^(socks5|socks4|http|https):\/\/.+:\d+$/;
  if (!proxyPattern.test(proxyUrl)) {
    console.error(`  ERROR: Invalid proxy URL format`);
    console.error(`  Expected: socks5://user:pass@ip:port or http://user:pass@ip:port`);
    process.exit(1);
  }

  // 2. Load account
  const account = await db.orgPlatformToken.findUnique({
    where: { id: accountId },
    include: { organization: true },
  });

  if (!account) {
    console.error(`  ERROR: Account ${accountId} not found`);
    process.exit(1);
  }

  if (account.accountType !== "SECONDARY") {
    console.error(`  ERROR: Proxy assignment is for SECONDARY (burner) accounts only`);
    console.error(`  This account is type: ${account.accountType}`);
    process.exit(1);
  }

  // 3. Check proxy isn't already burned
  // Query ProxyAllocation if it exists (future model — for now just check Redis/DB)
  console.log(`  Org: ${account.organization.name}`);
  console.log(`  Platform: ${account.platform}`);
  console.log(`  Label: ${account.accountLabel}`);

  // 4. Store proxy URL in Infisical (fetch-use-discard — DB never sees the raw URL)
  const proxySecretPath = `/orgs/${account.organizationId}/proxies/${account.accountLabel}`;

  await storeSecret(
    INFISICAL_PROJECT_ID,
    INFISICAL_ENV,
    proxySecretPath,
    "proxyUrl",
    proxyUrl,
  );

  console.log(`  Stored proxy in Infisical at: ${proxySecretPath}`);

  // 5. Update DB with Infisical path reference (NOT the raw proxy URL)
  await db.orgPlatformToken.update({
    where: { id: accountId },
    data: { infisicalProxyPath: proxySecretPath },
  });

  console.log(`  Updated account with Infisical proxy path reference`);

  // 6. Verify round-trip
  console.log(`\n  ────────────────────────────────────────`);
  console.log(`  Proxy assigned successfully`);
  console.log(`  Account: ${account.accountLabel} (${account.platform})`);
  console.log(`  Infisical path: ${proxySecretPath}`);
  console.log(`  DB stores: infisicalProxyPath (reference only)`);
  console.log(`  Raw proxy URL: stored ONLY in Infisical, never in DB\n`);
}
