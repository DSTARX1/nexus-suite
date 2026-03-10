# Nexus Suite

## Stack
- Next.js 15 + tRPC + Prisma 7 + PostgreSQL (pgvector) + Redis 7
- Mastra agents (multi-tier hierarchy), Docker Compose (10 services)
- Infisical (secrets), Cloudflare R2 (storage)
- Patchright (stealth browser), FFmpeg (media processing)
- pg-boss (job queues), BullMQ (specialized workers)

## Conventions
- Onion architecture: domain → repos → services → modules → api → app
- Multi-tenant: ALL content tables have `organizationId`
- Secrets: DB stores Infisical Secret IDs only, fetch-use-discard pattern
- Agent data minimization: `prepareContext()` strips input before agent calls
- Client plugins: `src/agents/clients/{org_id}/` — no direct Infisical access
- Full architecture in `ARCHITECTURE.md` (Decisions 1-10, phases, verification)

## Current Phase
**Phase:** [saraiknowsball #83-#93] — Chunks 1-5 done, starting Chunk 6/8

## Commands
```bash
docker compose up -d            # start all 10 services
docker compose up -d db redis   # start infra only
npx prisma migrate dev          # run migrations
npx prisma generate             # generate client
```

## Shell Commands
```bash
# Sequential pipeline (plan → build → validate → ship)
speedrun              # all open 'auto' issues
speedrun 214          # single issue
speedrun 214-220      # range
speedrun 214,216,220  # specific issues

# Parallel pipeline (up to 3 issues in isolated worktrees)
speedrunp              # all open 'auto' issues
speedrunp 214-220      # range

# Monitoring
speedrun-pcheck        # check parallel status
speedrun-ptail 214     # tail a parallel issue log
```
