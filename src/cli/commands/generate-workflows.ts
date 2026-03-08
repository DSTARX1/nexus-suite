import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";

const AGENTS_DIR = join(process.cwd(), "src", "agents", "clients");

export async function generateWorkflows(orgId: string, nicheOverride?: string) {
  console.log(`\n  Generating workflows for org: ${orgId}`);

  // 1. Load org + onboarding
  const org = await db.organization.findUnique({
    where: { id: orgId },
    include: { onboardingSubmission: true },
  });

  if (!org) {
    console.error(`  ERROR: Organization ${orgId} not found`);
    process.exit(1);
  }

  const submission = org.onboardingSubmission;
  if (!submission && !nicheOverride) {
    console.error(`  ERROR: No onboarding submission and no --niche flag provided`);
    process.exit(1);
  }

  const niche = nicheOverride ?? submission!.niche;
  const platforms = (submission?.platforms as string[]) ?? ["YOUTUBE", "TIKTOK"];
  const brandVoice = submission?.brandVoice ?? "Professional and engaging";
  const tonePreferences = submission?.tonePreferences ?? "";
  const postingFrequency = submission?.postingFrequency ?? "daily";
  const competitors = (submission?.competitorUrls as string[]) ?? [];

  console.log(`  Niche: ${niche}`);
  console.log(`  Platforms: ${platforms.join(", ")}`);

  // 2. Create client plugin directory structure
  const clientDir = join(AGENTS_DIR, orgId);
  const dirs = ["agents", "tools", "workflows"];

  for (const dir of dirs) {
    const fullPath = join(clientDir, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      console.log(`  Created: src/agents/clients/${orgId}/${dir}/`);
    }
  }

  // 3. Generate brand-prompt.md
  const brandPrompt = buildBrandPrompt(org.name, niche, brandVoice, tonePreferences, platforms);
  writeFileSync(join(clientDir, "brand-prompt.md"), brandPrompt);
  console.log(`  Created: brand-prompt.md`);

  // 4. Generate daily content pipeline workflow
  const dailyPipeline = buildDailyPipelineWorkflow(orgId, niche, platforms, postingFrequency);
  writeFileSync(join(clientDir, "workflows", "daily-pipeline.yaml"), dailyPipeline);
  console.log(`  Created: workflows/daily-pipeline.yaml`);

  // 5. Generate engagement sweep workflow
  const engagementSweep = buildEngagementSweepWorkflow(orgId, platforms);
  writeFileSync(join(clientDir, "workflows", "engagement-sweep.yaml"), engagementSweep);
  console.log(`  Created: workflows/engagement-sweep.yaml`);

  // 6. Generate competitor monitoring workflow (if competitors provided)
  if (competitors.length > 0) {
    const competitorWorkflow = buildCompetitorWorkflow(orgId, competitors);
    writeFileSync(join(clientDir, "workflows", "competitor-monitor.yaml"), competitorWorkflow);
    console.log(`  Created: workflows/competitor-monitor.yaml`);
  }

  // 7. Generate multiplier workflow (if tier supports it)
  if (org.multiplierEnabled) {
    const multiplierWorkflow = buildMultiplierWorkflow(orgId, platforms);
    writeFileSync(join(clientDir, "workflows", "content-multiply.yaml"), multiplierWorkflow);
    console.log(`  Created: workflows/content-multiply.yaml`);
  }

  console.log(`\n  ────────────────────────────────────────`);
  console.log(`  Generated workflows for ${org.name}`);
  console.log(`  Directory: src/agents/clients/${orgId}/`);
  console.log(`  Brand prompt: brand-prompt.md`);
  console.log(`  Workflows: ${competitors.length > 0 ? "3-4" : "2-3"} YAML files\n`);
}

// ── Template Builders ────────────────────────────────────────────

function buildBrandPrompt(
  orgName: string,
  niche: string,
  brandVoice: string,
  tonePreferences: string,
  platforms: string[],
): string {
  return `# Brand System Prompt — ${orgName}

## Niche
${niche}

## Brand Voice
${brandVoice}

## Tone Guidelines
${tonePreferences || "Match the brand voice described above. Be authentic and consistent."}

## Target Platforms
${platforms.map((p) => `- ${p}`).join("\n")}

## Content Rules
- All content must align with the brand voice above
- Never use competitor brand names negatively
- Maintain consistent terminology across platforms
- Adapt format per platform (short-form for TikTok/Reels, long-form for YouTube)
- Hashtags and captions must be platform-native

## Prohibited
- No medical/legal/financial advice without disclaimers
- No misleading claims or fake testimonials
- No content that could damage brand reputation
`;
}

function buildDailyPipelineWorkflow(
  orgId: string,
  niche: string,
  platforms: string[],
  frequency: string,
): string {
  const cronSchedule = frequency === "daily" ? "0 8 * * *" : "0 8 * * 1,3,5";

  return `name: daily-content-pipeline
description: Automated daily content creation and distribution for ${niche}
organizationId: ${orgId}

trigger:
  type: cron
  schedule: "${cronSchedule}"

steps:
  - id: discover-trends
    type: agent-delegate
    agent: trend-scout
    prompt: "Find 3 trending topics in ${niche} from the last 24 hours"
    outputAs: trends

  - id: select-topic
    type: agent-delegate
    agent: nexus-orchestrator
    prompt: "Pick the best topic from {{trends}} based on our content calendar and audience data"
    outputAs: selectedTopic

  - id: write-script
    type: agent-delegate
    agent: script-agent
    prompt: "Write a video script about {{selectedTopic}} in our brand voice"
    outputAs: script
    dependsOn: [select-topic]

  - id: generate-assets
    type: parallel
    dependsOn: [write-script]
    steps:
      - id: write-hooks
        type: agent-delegate
        agent: hook-writer
        prompt: "Write 5 viral hooks for: {{selectedTopic}}"
        outputAs: hooks

      - id: generate-title
        type: agent-delegate
        agent: title-generator
        prompt: "Generate 3 click-worthy titles for: {{selectedTopic}}"
        outputAs: titles

      - id: create-thumbnail
        type: agent-delegate
        agent: thumbnail-creator
        prompt: "Design thumbnail for: {{selectedTopic}}"
        outputAs: thumbnail

  - id: quality-check
    type: agent-delegate
    agent: quality-scorer
    prompt: "Score this content package: script={{script}}, hooks={{hooks}}, titles={{titles}}"
    outputAs: qualityScore
    dependsOn: [generate-assets]

  - id: gate-quality
    type: condition
    condition: "{{qualityScore.score}} >= 7"
    dependsOn: [quality-check]
    onTrue:
      - id: distribute
        type: parallel
        steps:
${platforms.map((p) => `          - id: post-${p.toLowerCase()}
            type: agent-delegate
            agent: ${p.toLowerCase()}-agent
            prompt: "Distribute content to ${p}: {{script}}, {{hooks}}, {{titles}}, {{thumbnail}}"`).join("\n")}
    onFalse:
      - id: revise
        type: agent-delegate
        agent: script-agent
        prompt: "Revise script based on quality feedback: {{qualityScore.feedback}}"
`;
}

function buildEngagementSweepWorkflow(orgId: string, platforms: string[]): string {
  return `name: engagement-sweep
description: Monitor and respond to engagement across all platforms
organizationId: ${orgId}

trigger:
  type: cron
  schedule: "0 */4 * * *"

steps:
  - id: scan-mentions
    type: parallel
    steps:
${platforms.map((p) => `      - id: scan-${p.toLowerCase()}
        type: agent-delegate
        agent: ${p.toLowerCase()}-agent
        prompt: "Scan recent comments, mentions, and DMs on ${p}. Prioritize by sentiment and reach."
        outputAs: ${p.toLowerCase()}Mentions`).join("\n")}

  - id: respond
    type: agent-delegate
    agent: engagement-responder
    prompt: "Respond to high-priority mentions across platforms: {{mentions}}"
    dependsOn: [scan-mentions]

  - id: report
    type: agent-delegate
    agent: analytics-reporter
    prompt: "Generate engagement summary for the last 4 hours"
    dependsOn: [respond]
`;
}

function buildCompetitorWorkflow(orgId: string, competitors: string[]): string {
  return `name: competitor-monitor
description: Track competitor content and detect outliers
organizationId: ${orgId}

trigger:
  type: cron
  schedule: "*/15 * * * *"

config:
  competitors:
${competitors.map((url) => `    - "${url}"`).join("\n")}
  outlierThreshold: 3.0

steps:
  - id: poll-competitors
    type: forEach
    collection: "{{config.competitors}}"
    as: competitorUrl
    steps:
      - id: scrape-profile
        type: action
        action: scraper-pool.scrape
        params:
          url: "{{competitorUrl}}"
          type: profile-posts
        outputAs: posts

      - id: detect-outliers
        type: action
        action: analytics.detectOutlier
        params:
          posts: "{{posts}}"
          threshold: "{{config.outlierThreshold}}"
        outputAs: outliers

  - id: process-outliers
    type: condition
    condition: "{{outliers.length}} > 0"
    dependsOn: [poll-competitors]
    onTrue:
      - id: analyze-outlier
        type: agent-delegate
        agent: viral-teardown-agent
        prompt: "Analyze this outlier content and generate a Viral Recipe: {{outliers[0]}}"
        outputAs: viralRecipe

      - id: reproduce
        type: agent-delegate
        agent: nexus-orchestrator
        prompt: "Create our version based on this viral recipe: {{viralRecipe}}"
        dependsOn: [analyze-outlier]
`;
}

function buildMultiplierWorkflow(orgId: string, platforms: string[]): string {
  return `name: content-multiply
description: Generate video variations and distribute across burner fleet
organizationId: ${orgId}

trigger:
  type: manual

input:
  sourceVideoUrl: string
  variationCount: number
  targetPlatforms: string[]

steps:
  - id: download-source
    type: action
    action: media-engine.download
    params:
      url: "{{input.sourceVideoUrl}}"
    outputAs: sourceVideo

  - id: analyze-audio
    type: action
    action: media-engine.analyzeAudio
    params:
      videoKey: "{{sourceVideo.r2Key}}"
    outputAs: audioAnalysis

  - id: generate-variations
    type: forEach
    collection: "{{range(1, input.variationCount)}}"
    as: variationIndex
    steps:
      - id: create-variation
        type: action
        action: media-engine.createVariation
        params:
          sourceKey: "{{sourceVideo.r2Key}}"
          index: "{{variationIndex}}"
          audioContainsCopyrightedMusic: "{{audioAnalysis.hasCopyrightedMusic}}"
        outputAs: variation

  - id: verify-uniqueness
    type: action
    action: media-engine.verifyHashUniqueness
    params:
      variations: "{{variations}}"
      minHammingDistance: 5
    dependsOn: [generate-variations]

  - id: generate-captions
    type: forEach
    collection: "{{variations}}"
    as: variation
    dependsOn: [verify-uniqueness]
    steps:
      - id: write-caption
        type: agent-delegate
        agent: caption-writer
        prompt: "Write a unique caption for variation {{variation.index}} on {{variation.targetPlatform}}"
        outputAs: caption

  - id: schedule-distribution
    type: action
    action: distribution.scheduleStaggered
    params:
      variations: "{{variations}}"
      captions: "{{captions}}"
      platforms: "{{input.targetPlatforms}}"
    dependsOn: [generate-captions]
`;
}
