# Nexus Suite

## Architecture
Full plan in `@ARCHITECTURE.md` — all decisions (1-10), implementation phases, verification criteria.

## Stack
- Next.js 15 + tRPC + Prisma 7 + PostgreSQL (pgvector) + Redis 7
- Mastra agents (multi-tier hierarchy)
- Docker Compose (10 services)
- Infisical (secrets), Cloudflare R2 (storage)
- Patchright (stealth browser), FFmpeg (media processing)
- pg-boss + BullMQ (job queues)

## Conventions
- Onion architecture: domain → repos → services → modules → api → app
- Multi-tenant: ALL content tables have `organizationId`
- Secrets: DB stores Infisical Secret IDs only, fetch-use-discard pattern
- Agent data minimization: `prepareContext()` strips input before agent calls
- Client plugins: `src/agents/clients/{org_id}/` — no direct Infisical access

## Current Phase
**Phase:** build - Chunk 1/3 done - #76

## Commands
- `docker compose up -d` — start all 10 services
- `docker compose up -d db redis` — start infra only
- `npx prisma migrate dev` — run migrations
- `npx prisma generate` — generate client

## Shell Commands

### `speedrun` — Sequential feature pipeline
Runs issues one at a time through plan → build → validate → ship.
```bash
speedrun              # all open issues with 'auto' label
speedrun 214          # single issue
speedrun 214-220      # range
speedrun 214,216,220  # specific issues
```

### `speedrun-parallel` — Parallel feature pipeline
Runs up to 3 issues simultaneously in isolated git worktrees.
```bash
speedrunp              # all open issues with 'auto' label
speedrunp 214-220      # range
```

### `speedrun-pcheck` — Check parallel speedrun status
```bash
speedrun-pcheck
```

### `speedrun-ptail` — Tail a parallel issue log
```bash
speedrun-ptail 214
```
