#!/bin/bash
set -eo pipefail

# ── CUSTOMIZE THESE (run-chunks fills them in) ──────────────────────────────
PROJECT_DIR="${WORKTREE_PROJECT_DIR:-/Users/imorgado/nexus-suite/.claude/worktrees/feature-4}"
LOG_DIR="$PROJECT_DIR/.claude/logs"
CHECK_CMD="npx tsc --noEmit 2>&1 || true"

# Ensure node_modules/.bin + bun + project venvs in PATH for non-interactive shells
export PATH="$PROJECT_DIR/node_modules/.bin:$HOME/.bun/bin:$PATH"
for _venv in "$PROJECT_DIR"/.venv "$PROJECT_DIR"/*/.venv; do
  [[ -d "$_venv/bin" ]] && export PATH="$_venv/bin:$PATH"
done
# Disable git pager so diff/log never blocks on (END)
export GIT_PAGER=cat
# Disable husky pre-commit hooks for all git operations (script + Claude CLI)
export HUSKY=0
FEATURE_NAME="__FEATURE_NAME__"
ISSUE_NUM="__ISSUE_NUM__"

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

# Parse args (--issue overrides baked-in value)
while [[ $# -gt 0 ]]; do
  case $1 in
    --start) START_CHUNK="$2"; shift 2 ;;
    --issue) ISSUE_NUM="$2"; shift 2 ;;
    --cleanup-every) CLEANUP_EVERY="$2"; shift 2 ;;
    --skip-final-check) SKIP_FINAL_CHECK=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Auto-detect issue from CLAUDE.md if still placeholder
# Note: comparison uses string concat so sed doesn't replace it during generation
PLACEHOLDER="__ISSUE""_NUM__"
if [[ "$ISSUE_NUM" == "$PLACEHOLDER" || -z "$ISSUE_NUM" ]]; then
  ISSUE_NUM=$(grep '^\*\*Phase:\*\*' "$PROJECT_DIR/CLAUDE.md" 2>/dev/null | grep -oE '#[0-9]+' | tail -1 | tr -d '#' || true)
fi
[[ -z "$ISSUE_NUM" ]] && echo -e "${RED}✗ No issue #. Pass --issue N or update CLAUDE.md.${NC}" && exit 1

# Fetch plan from GitHub issue
PLAN_FILE=$(mktemp)
trap 'rm -f "$PLAN_FILE"' EXIT
echo -e "${BLUE}Fetching plan from issue #${ISSUE_NUM}...${NC}"
gh issue view "$ISSUE_NUM" --json body -q '.body' > "$PLAN_FILE" 2>/dev/null || { echo -e "${RED}✗ Failed to fetch issue #${ISSUE_NUM}${NC}"; exit 1; }

mkdir -p "$LOG_DIR"

echo -e "${BLUE}══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Plan Executor - $(basename "$PROJECT_DIR")${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════${NC}"

TOTAL_CHUNKS=$(grep -cE "^#{3,4} Chunk [0-9]+:" "$PLAN_FILE" || echo "0")
echo -e "${GREEN}✓${NC} Issue: #$ISSUE_NUM"
echo -e "${GREEN}✓${NC} $TOTAL_CHUNKS chunks, starting from $START_CHUNK"
echo -e "${GREEN}✓${NC} Feature: $FEATURE_NAME"
echo -e "${GREEN}✓${NC} Checks: $CHECK_CMD"
[[ "$CLEANUP_EVERY" -gt 0 ]] && echo -e "${GREEN}✓${NC} Cleanup every $CLEANUP_EVERY chunks"
echo ""

# ── Pre-read ALL chunks into arrays BEFORE any Claude invocations ───────────
declare -a CHUNK_NUMS=()
declare -a CHUNK_NAMES=()

while IFS= read -r line; do
  num=$(echo "$line" | grep -oE "Chunk [0-9]+" | grep -oE "[0-9]+")
  name=$(echo "$line" | sed -E 's/#{3,4} Chunk [0-9]+: //' | sed 's/ (parallel-safe:.*//' | sed -E 's/[[:space:]]*(✅|⚠️|❌|✓|✗|\[DONE\]| DONE).*//')
  [[ -n "$num" ]] && CHUNK_NUMS+=("$num") && CHUNK_NAMES+=("$name")
done < <(grep -E "^#{3,4} Chunk [0-9]+:" "$PLAN_FILE")

echo -e "${GREEN}✓${NC} Chunks: ${CHUNK_NUMS[*]}"
echo ""

# Guard: exit if no chunks detected (prevents premature issue closure)
if [[ ${#CHUNK_NUMS[@]} -eq 0 ]]; then
  # Check if all checkboxes are already done (feature built during plan phase)
  _total_cb=$(grep -cE '^\s*- \[(x| )\]' "$PLAN_FILE" || echo "0")
  _done_cb=$(grep -cE '^\s*- \[x\]' "$PLAN_FILE" || echo "0")
  if [[ "$_total_cb" -gt 0 && "$_total_cb" == "$_done_cb" ]]; then
    echo -e "${GREEN}✓ All $_total_cb tasks already complete in #${ISSUE_NUM} — nothing to build${NC}"
    exit 0
  fi
  echo -e "${RED}✗ No chunks found in plan issue #${ISSUE_NUM}${NC}"
  echo -e "${RED}  Expected headers matching: ^#{3,4} Chunk [0-9]+:${NC}"
  echo -e "${RED}  Plan content preview:${NC}"
  head -30 "$PLAN_FILE"
  exit 1
fi

# ── Mark chunk done in GitHub issue ─────────────────────────────────────────
mark_chunk_done() {
  local num=$1 body
  body=$(gh issue view "$ISSUE_NUM" --json body -q '.body' 2>/dev/null) || { echo -e "${YELLOW}  ⚠ Could not fetch issue for checkbox update${NC}"; return 0; }
  echo "$body" | sed "s/- \[ \] Chunk ${num}:/- [x] Chunk ${num}:/" | gh issue edit "$ISSUE_NUM" -F - 2>/dev/null \
    && echo -e "${GREEN}  ✓ Issue #${ISSUE_NUM}: Chunk ${num} checked off${NC}" \
    || echo -e "${YELLOW}  ⚠ Could not update checkbox (non-fatal)${NC}"
}

# ── Context bridge ──────────────────────────────────────────────────────────
PREV_CHUNK_CONTEXT=""
capture_context() {
  cd "$PROJECT_DIR"
  PREV_CHUNK_CONTEXT=$(git log -1 --stat --format="" 2>/dev/null || echo "(no git changes)")
}

# ── Prompt generation ───────────────────────────────────────────────────────
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
Continue work on $(basename "$PROJECT_DIR") at $PROJECT_DIR

**Phase**: build | **Feature**: $FEATURE_NAME | **Chunk**: $num/$TOTAL_CHUNKS — $name | **Plan**: #$ISSUE_NUM
$context_section

Fetch plan: gh issue view $ISSUE_NUM --json body -q '.body' — locate Chunk $num.
Read ALL referenced files BEFORE writing. Implement exactly what Chunk $num describes.
Run: $CHECK_CMD. Fix errors. Update CLAUDE.md phase line. Do NOT ask questions.
PROMPT
}

generate_fix_prompt() {
  cat << PROMPT
Continue work on $(basename "$PROJECT_DIR") at $PROJECT_DIR

**Phase**: fix | **Feature**: $FEATURE_NAME

Quality checks failed. Fix ALL errors below — minimal changes only.
\`\`\`
$1
\`\`\`
Re-run: $CHECK_CMD. Loop until clean. Do NOT ask questions.
PROMPT
}

# ── Run a chunk ─────────────────────────────────────────────────────────────
run_chunk() {
  local num=$1 name=$2 log="$LOG_DIR/chunk-${1}.log"
  local max_attempts=2 attempt=1
  mkdir -p "$LOG_DIR"  # re-create if Claude CLI clobbered .claude/
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}▶ Chunk $num/$TOTAL_CHUNKS: $name${NC}  Log: $log"

  while [[ $attempt -le $max_attempts ]]; do
    cd "$PROJECT_DIR"
    unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT 2>/dev/null || true

    local prompt
    if [[ $attempt -eq 1 ]]; then
      prompt="$(generate_prompt "$num" "$name" "$PREV_CHUNK_CONTEXT")"
    else
      prompt="Continue work on $(basename "$PROJECT_DIR") at $PROJECT_DIR

**Phase**: build (CONTINUATION) | **Chunk**: $num/$TOTAL_CHUNKS — $name | **Plan**: #$ISSUE_NUM

Previous attempt hit the turn limit. Continue where it left off.
Run: git diff --stat to see what was already done. Complete remaining work for Chunk $num.
Fetch plan: gh issue view $ISSUE_NUM --json body -q '.body' — locate Chunk $num.
Run: $CHECK_CMD. Fix errors. Do NOT ask questions."
    fi

    if claude --dangerously-skip-permissions --max-turns 120 --fallback-model claude-sonnet-4-6 \
              -p "$prompt" \
              < /dev/null 2>&1 | tee "$log"; then
      if grep -qE "max.turns|turn limit|Maximum number of turns" "$log"; then
        echo -e "${YELLOW}⚠ Chunk $num hit turn limit (attempt $attempt/$max_attempts)${NC}"
        # Commit partial work before retry
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
      echo -e "${RED}✗ Chunk $num failed (non-turn-limit error) — check $log${NC}"
      return 1
    fi
  done

  echo -e "${YELLOW}⚠ Chunk $num incomplete after $max_attempts attempts — continuing${NC}"
  return 1
}

# ── Quality gate ────────────────────────────────────────────────────────────
run_quality_gate() {
  local num=$1 gate_log="$LOG_DIR/gate-${1}.log"
  mkdir -p "$LOG_DIR"  # re-create if Claude CLI clobbered .claude/
  echo -e "${CYAN}  Quality gate after chunk $num...${NC}"
  cd "$PROJECT_DIR"

  if eval "$CHECK_CMD" > "$gate_log" 2>&1; then
    echo -e "${GREEN}  ✓ Passed${NC}"; return 0
  fi

  echo -e "${YELLOW}  ⚠ Failed — fix pass...${NC}"
  local fix_log="$LOG_DIR/fix-${num}.log"
  unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT 2>/dev/null || true
  if claude --dangerously-skip-permissions --max-turns 50 --fallback-model claude-sonnet-4-6 \
            -p "$(generate_fix_prompt "$(cat "$gate_log")")" \
            < /dev/null 2>&1 | tee "$fix_log"; then
    if eval "$CHECK_CMD" > "$gate_log" 2>&1; then
      echo -e "${GREEN}  ✓ Fixed${NC}"; return 0
    fi
  fi
  echo -e "${RED}  ✗ Still failing — continuing${NC}"; return 1
}

run_cleanup() {
  echo -e "${CYAN}▶ CLAUDE.md cleanup...${NC}"
  cd "$PROJECT_DIR"
  mkdir -p "$LOG_DIR"
  if claude --dangerously-skip-permissions --max-turns 10 --fallback-model claude-sonnet-4-6 \
         -p "Run /setup-claude-md to clean up CLAUDE.md. Keep it minimal." \
         < /dev/null 2>&1 | tee "$LOG_DIR/cleanup.log"; then
    echo -e "${GREEN}  ✓ Cleanup done${NC}"
  else
    echo -e "${YELLOW}  ⚠ Cleanup failed (non-fatal)${NC}"
  fi
}

# ── Main loop ───────────────────────────────────────────────────────────────
CHUNKS_SINCE_CLEANUP=0
for i in "${!CHUNK_NUMS[@]}"; do
  num="${CHUNK_NUMS[$i]}" name="${CHUNK_NAMES[$i]}"
  [[ "$num" -lt "$START_CHUNK" ]] && echo -e "${YELLOW}  Skip chunk $num${NC}" && continue

  # Skip chunks whose checkbox is already checked [x]
  if grep -qE "^\s*- \[x\] Chunk ${num}:" "$PLAN_FILE"; then
    echo -e "${GREEN}✓${NC} Chunk $num already done (checkbox checked) — skipping"
    continue
  fi

  run_chunk "$num" "$name" || echo -e "${YELLOW}⚠ Chunk $num had issues — quality gate will assess${NC}"
  run_quality_gate "$num" || true  # continue even if gate fails — validate phase catches

  # Capture context BEFORE commit so next chunk sees what changed
  capture_context

  # Checkpoint commit after each chunk (catches CLAUDE.md + any uncommitted work)
  cd "$PROJECT_DIR"
  if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    git add -A
    git -c core.hooksPath=/dev/null commit -m "checkpoint: chunk $num — $name" 2>>"$LOG_DIR/chunk-${num}.log" || true
    echo -e "${GREEN}  ✓ Checkpoint commit${NC}"
  fi

  mark_chunk_done "$num"

  CHUNKS_SINCE_CLEANUP=$((CHUNKS_SINCE_CLEANUP + 1))
  if [[ "$CLEANUP_EVERY" -gt 0 && "$CHUNKS_SINCE_CLEANUP" -ge "$CLEANUP_EVERY" ]]; then
    run_cleanup; CHUNKS_SINCE_CLEANUP=0
  fi
done

echo -e "\n${GREEN}══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  All chunks complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}\n"

# Close the plan issue — only if it's actually a plan issue (title starts with "Plan:")
_plan_title=$(gh issue view "$ISSUE_NUM" --json title -q '.title' 2>/dev/null || true)
if [[ "$_plan_title" == Plan:* ]]; then
  echo -e "${BLUE}Closing plan issue #${ISSUE_NUM}...${NC}"
  gh issue close "$ISSUE_NUM" 2>/dev/null && echo -e "${GREEN}✓ Issue #${ISSUE_NUM} closed${NC}" || echo -e "${YELLOW}⚠ Could not close #${ISSUE_NUM}${NC}"
else
  echo -e "${YELLOW}⚠ Skipping close — #${ISSUE_NUM} is not a plan issue${NC}"
fi

if [[ "$SKIP_FINAL_CHECK" != "true" ]]; then
  echo -e "${BLUE}Final quality checks...${NC}"
  cd "$PROJECT_DIR"
  eval "$CHECK_CMD" && echo -e "${GREEN}✓ All passed${NC}" || { echo -e "${RED}✗ Failed${NC}"; exit 1; }
fi

echo -e "\n${GREEN}Done!${NC} git diff → /save → /hp"
