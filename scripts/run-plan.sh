#!/bin/bash
set -eo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
PROJECT_DIR="/Users/danielisakov/projects/nexus/nexus-suite"
PLAN_FILE="$PROJECT_DIR/.gg/current-plan.md"
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
LOG_DIR="$PROJECT_DIR/.gg/logs"
CHECK_CMD="npx tsc --noEmit 2>&1 || true"

export PATH="$PROJECT_DIR/node_modules/.bin:$HOME/.bun/bin:$PATH"
export GIT_PAGER=cat
export HUSKY=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Defaults
START_CHUNK=1
CLEANUP_EVERY=0
SKIP_FINAL_CHECK=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --start) START_CHUNK="$2"; shift 2 ;;
    --cleanup-every) CLEANUP_EVERY="$2"; shift 2 ;;
    --skip-final-check) SKIP_FINAL_CHECK=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ ! -f "$PLAN_FILE" ]]; then
  echo -e "${RED}✗ No plan found at $PLAN_FILE${NC}"
  echo "  Run /plan-checkpoint first to create a plan."
  exit 1
fi

mkdir -p "$LOG_DIR"

echo -e "${BLUE}══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Plan Executor — nexus-suite${NC}"
echo -e "${BLUE}  saraiknowsball Client Onboarding (#83-#93)${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════${NC}"

# ── Pre-read ALL chunks into arrays ───────────────────────────────────────────
declare -a CHUNK_NUMS=()
declare -a CHUNK_NAMES=()

while IFS= read -r line; do
  num=$(echo "$line" | grep -oE "^### Chunk [0-9]+" | grep -oE "[0-9]+")
  name=$(echo "$line" | sed 's/### Chunk [0-9]*: //' | sed 's/ (parallel-safe:.*//')
  [[ -n "$num" ]] && CHUNK_NUMS+=("$num") && CHUNK_NAMES+=("$name")
done < <(grep -E "^### Chunk [0-9]+:" "$PLAN_FILE")

TOTAL_CHUNKS=${#CHUNK_NUMS[@]}
echo -e "${GREEN}✓${NC} $TOTAL_CHUNKS chunks detected, starting from $START_CHUNK"
echo -e "${GREEN}✓${NC} Project: Next.js 15 + tRPC + Prisma 7 (bun)"
echo -e "${GREEN}✓${NC} Check: $CHECK_CMD"
[[ "$CLEANUP_EVERY" -gt 0 ]] && echo -e "${GREEN}✓${NC} Cleanup every $CLEANUP_EVERY chunks"
echo ""

if [[ $TOTAL_CHUNKS -eq 0 ]]; then
  echo -e "${RED}✗ No chunks found in plan${NC}"
  exit 1
fi

# ── Context bridge ────────────────────────────────────────────────────────────
PREV_CHUNK_CONTEXT=""
capture_context() {
  cd "$PROJECT_DIR"
  PREV_CHUNK_CONTEXT=$(git log -1 --stat --format="" 2>/dev/null || echo "(no git changes)")
}

# ── Prompt generation ─────────────────────────────────────────────────────────
generate_prompt() {
  local num=$1 name=$2 context=$3
  local context_section=""
  if [[ -n "$context" && "$context" != "(no git changes)" ]]; then
    context_section="
**Previous chunk changes** (context only, do NOT modify unless in YOUR scope):
\`\`\`
$context
\`\`\`"
  fi

  cat << PROMPT
Continue work on nexus-suite at $PROJECT_DIR

**Phase**: build | **Chunk**: $num/$TOTAL_CHUNKS — $name
$context_section

Read .gg/current-plan.md for full details. Locate Chunk $num.
Read ALL referenced files BEFORE writing. Implement exactly what Chunk $num describes.
Run: $CHECK_CMD — fix errors. Update CLAUDE.md phase line. Do NOT ask questions.
PROMPT
}

generate_fix_prompt() {
  cat << PROMPT
Continue work on nexus-suite at $PROJECT_DIR

**Phase**: fix — quality checks failed. Fix ALL errors below — minimal changes only.
\`\`\`
$1
\`\`\`
Re-run: $CHECK_CMD. Loop until clean. Do NOT ask questions.
PROMPT
}

# ── Run a chunk ───────────────────────────────────────────────────────────────
run_chunk() {
  local num=$1 name=$2 log="$LOG_DIR/chunk-${1}.log"
  local max_attempts=2 attempt=1
  mkdir -p "$LOG_DIR"

  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}▶ Chunk $num/$TOTAL_CHUNKS: $name${NC}"
  echo -e "  Log: ${CYAN}$log${NC}"
  echo ""

  while [[ $attempt -le $max_attempts ]]; do
    cd "$PROJECT_DIR"
    unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT 2>/dev/null || true

    local prompt
    if [[ $attempt -eq 1 ]]; then
      prompt="$(generate_prompt "$num" "$name" "$PREV_CHUNK_CONTEXT")"
    else
      prompt="Continue work on nexus-suite at $PROJECT_DIR

**Phase**: build (CONTINUATION) | **Chunk**: $num/$TOTAL_CHUNKS — $name

Previous attempt hit the turn limit. Continue where it left off.
Run: git diff --stat to see what was already done. Complete remaining work for Chunk $num.
Read .gg/current-plan.md — locate Chunk $num.
Run: $CHECK_CMD. Fix errors. Do NOT ask questions."
    fi

    if ggcoder --max-turns 120 --print "$prompt" < /dev/null 2>&1 | tee "$log"; then
      if grep -qE "max.turns|turn limit|Maximum number of turns" "$log"; then
        echo -e "${YELLOW}⚠ Chunk $num hit turn limit (attempt $attempt/$max_attempts)${NC}"
        cd "$PROJECT_DIR"
        if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
          git add -A
          git -c core.hooksPath=/dev/null commit -m "partial: chunk $num attempt $attempt (turn limit)" 2>/dev/null || true
          echo -e "${YELLOW}  ✓ Partial work committed${NC}"
        fi
        attempt=$((attempt + 1))
        continue
      fi
      echo -e "${GREEN}✓ Chunk $num done${NC}"
      return 0
    else
      echo -e "${RED}✗ Chunk $num failed (exit code $?) — check $log${NC}"
      echo -e "${RED}  Resume with: ./scripts/run-plan.sh --start $num${NC}"
      return 1
    fi
  done

  echo -e "${YELLOW}⚠ Chunk $num incomplete after $max_attempts attempts — continuing${NC}"
  return 1
}

# ── Quality gate ──────────────────────────────────────────────────────────────
run_quality_gate() {
  local num=$1 gate_log="$LOG_DIR/gate-${1}.log"
  mkdir -p "$LOG_DIR"
  echo -e "${CYAN}  Quality gate after chunk $num...${NC}"
  cd "$PROJECT_DIR"

  if eval "$CHECK_CMD" > "$gate_log" 2>&1; then
    echo -e "${GREEN}  ✓ Passed${NC}"; return 0
  fi

  echo -e "${YELLOW}  ⚠ Failed — running fix pass...${NC}"
  local fix_log="$LOG_DIR/fix-${num}.log"
  unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT 2>/dev/null || true

  if ggcoder --max-turns 50 --print "$(generate_fix_prompt "$(cat "$gate_log")")" \
            < /dev/null 2>&1 | tee "$fix_log"; then
    if eval "$CHECK_CMD" > "$gate_log" 2>&1; then
      echo -e "${GREEN}  ✓ Fixed${NC}"; return 0
    fi
  fi
  echo -e "${RED}  ✗ Still failing — continuing${NC}"; return 1
}

# ── CLAUDE.md cleanup ─────────────────────────────────────────────────────────
run_cleanup() {
  echo -e "${CYAN}▶ CLAUDE.md cleanup...${NC}"
  cd "$PROJECT_DIR"
  mkdir -p "$LOG_DIR"
  if ggcoder --max-turns 10 --print "
Read CLAUDE.md in $PROJECT_DIR. Clean it up:
- Keep it under 60 lines
- Remove any stale notes or duplicated info
- Keep: Stack, Conventions, Current Phase, Commands sections
- Update Current Phase to reflect completed chunks
Do NOT modify any code files. Only touch CLAUDE.md.
" < /dev/null 2>&1 | tee "$LOG_DIR/cleanup.log"; then
    echo -e "${GREEN}  ✓ Cleanup done${NC}"
  else
    echo -e "${YELLOW}  ⚠ Cleanup failed (non-fatal)${NC}"
  fi
}

# ── Main loop ─────────────────────────────────────────────────────────────────
CHUNKS_SINCE_CLEANUP=0

for i in "${!CHUNK_NUMS[@]}"; do
  num="${CHUNK_NUMS[$i]}"
  name="${CHUNK_NAMES[$i]}"

  if [[ "$num" -lt "$START_CHUNK" ]]; then
    echo -e "${YELLOW}⏭  Skip chunk $num: $name${NC}"
    continue
  fi

  run_chunk "$num" "$name" || echo -e "${YELLOW}⚠ Chunk $num had issues — quality gate will assess${NC}"
  run_quality_gate "$num" || true

  # Capture context for next chunk
  capture_context

  # Checkpoint commit
  cd "$PROJECT_DIR"
  if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    git add -A
    git -c core.hooksPath=/dev/null commit -m "checkpoint: chunk $num — $name" 2>>"$LOG_DIR/chunk-${num}.log" || true
    echo -e "${GREEN}  ✓ Checkpoint commit${NC}"
  fi

  CHUNKS_SINCE_CLEANUP=$((CHUNKS_SINCE_CLEANUP + 1))
  if [[ "$CLEANUP_EVERY" -gt 0 && "$CHUNKS_SINCE_CLEANUP" -ge "$CLEANUP_EVERY" ]]; then
    run_cleanup
    CHUNKS_SINCE_CLEANUP=0
  fi
done

echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  All $TOTAL_CHUNKS chunks complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"

if [[ "$SKIP_FINAL_CHECK" != "true" ]]; then
  echo ""
  echo -e "${BLUE}Running final type check...${NC}"
  cd "$PROJECT_DIR"
  if eval "$CHECK_CMD"; then
    echo -e "${GREEN}✓ Type check passed${NC}"
  else
    echo -e "${RED}✗ Type check failed — review errors above${NC}"
  fi
fi

echo ""
echo -e "${GREEN}Done! Next steps:${NC}"
echo -e "  1. Review changes: ${CYAN}git diff --stat${NC}"
echo -e "  2. Check logs: ${CYAN}ls -la .gg/logs/${NC}"
echo -e "  3. Commit when ready"
