import { db } from "@/lib/db";
import { generateBrowserProfile } from "@/lib/fingerprint";
import { storeSecret } from "@/lib/infisical";

const INFISICAL_PROJECT_ID = process.env.INFISICAL_PROJECT_ID!;
const INFISICAL_ENV = process.env.INFISICAL_ENV ?? "dev";

export async function provision(orgId: string, burnerCount: number) {
  console.log(`\n  Provisioning org: ${orgId}`);
  console.log(`  Burner accounts: ${burnerCount}\n`);

  // 1. Load org + onboarding data
  const org = await db.organization.findUnique({
    where: { id: orgId },
    include: {
      onboardingSubmission: true,
      platformTokens: true,
    },
  });

  if (!org) {
    console.error(`  ERROR: Organization ${orgId} not found`);
    process.exit(1);
  }

  if (!org.onboardingSubmission) {
    console.error(`  ERROR: No onboarding submission found. Client must complete the wizard first.`);
    process.exit(1);
  }

  if (org.onboardingStatus !== "PENDING_SETUP") {
    console.error(`  ERROR: Org status is ${org.onboardingStatus}, expected PENDING_SETUP`);
    process.exit(1);
  }

  const submission = org.onboardingSubmission;
  const platforms = submission.platforms as string[];

  console.log(`  Niche: ${submission.niche}`);
  console.log(`  Platforms: ${platforms.join(", ")}`);
  console.log(`  Tier: ${org.pricingTier}`);
  console.log(`  Max accounts: ${org.maxAccounts}\n`);

  // Guard: don't exceed tier limit
  const existingCount = org.platformTokens.length;
  const toCreate = Math.min(burnerCount, org.maxAccounts - existingCount);

  if (toCreate <= 0) {
    console.error(`  ERROR: Account limit reached (${existingCount}/${org.maxAccounts})`);
    process.exit(1);
  }

  // 2. Generate burner profiles + platform tokens
  console.log(`  Generating ${toCreate} burner profiles...\n`);

  for (let i = 0; i < toCreate; i++) {
    const platformIndex = i % platforms.length;
    const platform = platforms[platformIndex];
    const label = `Burner-${platform}-${existingCount + i + 1}`;

    // Generate unique browser fingerprint
    const profile = generateBrowserProfile();

    // Create BrowserProfile + OrgPlatformToken in a transaction
    const result = await db.$transaction(async (tx) => {
      const browserProfile = await tx.browserProfile.create({
        data: {
          userAgent: profile.userAgent,
          screenWidth: profile.screenWidth,
          screenHeight: profile.screenHeight,
          hardwareConcurrency: profile.hardwareConcurrency,
          platform: profile.platform,
          languages: profile.languages,
          canvasNoiseSeed: profile.canvasNoiseSeed,
          webglVendor: profile.webglVendor,
          webglRenderer: profile.webglRenderer,
          timezone: profile.timezone,
          locale: profile.locale,
        },
      });

      // Infisical secret path for this account's credentials
      const secretPath = `/orgs/${orgId}/tokens/${label}`;

      // Store a placeholder in Infisical (admin fills real credentials later)
      await storeSecret(
        INFISICAL_PROJECT_ID,
        INFISICAL_ENV,
        secretPath,
        "accessToken",
        "PLACEHOLDER_FILL_AFTER_MANUAL_LOGIN",
      );

      const token = await tx.orgPlatformToken.create({
        data: {
          organizationId: orgId,
          platform: platform as any,
          accountLabel: label,
          accountType: "SECONDARY",
          infisicalSecretPath: secretPath,
          fingerprintProfileId: browserProfile.id,
          warmupStatus: "NOT_STARTED",
          sessionStoragePath: `sessions/${orgId}/${browserProfile.id}/state.json`,
        },
      });

      return { token, browserProfile };
    });

    console.log(`  [${i + 1}/${toCreate}] Created ${label}`);
    console.log(`    Platform: ${platform}`);
    console.log(`    Profile ID: ${result.browserProfile.id}`);
    console.log(`    UA: ${profile.userAgent.slice(0, 60)}...`);
    console.log(`    Screen: ${profile.screenWidth}x${profile.screenHeight}`);
    console.log(`    WebGL: ${profile.webglVendor} / ${profile.webglRenderer.slice(0, 40)}...`);
    console.log(`    Timezone: ${profile.timezone}`);
    console.log(`    Infisical: ${result.token.infisicalSecretPath}`);
    console.log(`    Session R2: ${result.token.sessionStoragePath}\n`);
  }

  // 3. Summary
  console.log(`  ────────────────────────────────────────`);
  console.log(`  Provisioned ${toCreate} burner accounts for ${org.name}`);
  console.log(`  Total accounts: ${existingCount + toCreate}/${org.maxAccounts}`);
  console.log(`\n  Next steps:`);
  console.log(`    1. Assign proxies:  npx tsx src/cli/index.ts assign-proxy <accountId> <proxyUrl>`);
  console.log(`    2. Manual login:    Log into each burner in Patchright with its fingerprint`);
  console.log(`    3. Start warming:   npx tsx src/cli/index.ts warmup-start <accountId>`);
  console.log(`    4. Gen workflows:   npx tsx src/cli/index.ts generate-workflows ${orgId}`);
  console.log(`    5. Activate:        Set onboardingStatus → ACTIVE in /admin\n`);
}
