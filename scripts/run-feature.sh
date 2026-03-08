#!/bin/bash
set -eo pipefail

# ── CUSTOMIZE THESE (run-feature fills them in) ──────────────────────────────
PROJECT_DIR="${WORKTREE_PROJECT_DIR:-/Users/imorgado/nexus-suite}"
CHECK_CMD="npx tsc --noEmit"

# Ensure node_modules/.bin + bun + project venvs in PATH
export PATH="$PROJECT_DIR/node_modules/.bin:$HOME/.bun/bin:$PATH"
for _venv in "$PROJECT_DIR"/.venv "$PROJECT_DIR"/*/.venv; do
  [[ -d "$_venv/bin" ]] && export PATH="$_venv/bin:$PATH"
done
# Disable git pager so diff/log never blocks on (END)
export GIT_PAGER=cat
# Disable husky pre-commit hooks for all git operations (script + Claude CLI)
export HUSKY=0

# ── Safe git add (ensures .gitignore exists, strips generated dirs) ──────────
safe_git_add() {
  local _dir="${1:-$PROJECT_DIR}"
  cd "$_dir"
  # Create minimal .gitignore if missing
  if [[ ! -f ".gitignore" ]]; then
    printf '%s\n' "node_modules/" ".next/" "dist/" ".venv/" "__pycache__/" "*.pyc" "*.log" ".claude/logs/" ".DS_Store" > .gitignore
  fi
  git add -A
  # Safety net: unstage generated dirs even if .gitignore was added late
  git reset HEAD -- node_modules/ .next/ dist/ __pycache__/ .venv/ 2>/dev/null || true
}

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Defaults
FEATURE_ISSUE=""
START_PHASE="plan"
SKIP_VALIDATE=false
PLAN_ISSUE=""
LABEL="auto"
RUN_ALL=false
SKIP_SHIP=false

# Per-user branch prefix (override via SHIPIT_USER env var)
_raw_user="${SHIPIT_USER:-$(git config user.name 2>/dev/null || echo user)}"
BRANCH_PREFIX="$(echo "$_raw_user" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')"
unset _raw_user

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --issue) FEATURE_ISSUE="$2"; shift 2 ;;
    --start-phase) START_PHASE="$2"; shift 2 ;;
    --skip-validate) SKIP_VALIDATE=true; shift ;;
    --plan-issue) PLAN_ISSUE="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --all) RUN_ALL=true; shift ;;
    --skip-ship) SKIP_SHIP=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --all mode: loop through all open issues with label
if [[ "$RUN_ALL" == "true" ]]; then
  echo -e "${BLUE}Fetching all open issues labeled '$LABEL'...${NC}"
  ISSUES=$(gh api "repos/{owner}/{repo}/issues?labels=$LABEL&state=open&per_page=100" --jq '.[].number' | sort -n)
  ISSUE_COUNT=$(echo "$ISSUES" | wc -w | tr -d ' ')
  echo -e "${GREEN}✓${NC} Found $ISSUE_COUNT issues: $ISSUES"
  echo ""
  for issue in $ISSUES; do
    echo -e "${BLUE}════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  Starting issue #$issue ($ISSUE_COUNT remaining)${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════${NC}"
    "$0" --issue "$issue" --label "$LABEL" && echo -e "${GREEN}✓ Issue #$issue complete${NC}" \
      || echo -e "${RED}✗ Issue #$issue failed — continuing to next${NC}"
    ISSUE_COUNT=$((ISSUE_COUNT - 1))
  done
  echo -e "\n${GREEN}══════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  All issues processed!${NC}"
  echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
  exit 0
fi

[[ -z "$FEATURE_ISSUE" ]] && echo -e "${RED}✗ --issue N or --all required${NC}" && exit 1

# Validate --start-phase
VALID_PHASES="plan build validate ship"
if [[ ! " $VALID_PHASES " =~ " $START_PHASE " ]]; then
  echo -e "${RED}✗ Invalid --start-phase '$START_PHASE'. Must be: $VALID_PHASES${NC}" && exit 1
fi

# ── Setup ──────────────────────────────────────────────────────────────────────
PROJECT_NAME=$(basename "$PROJECT_DIR")
LOG_DIR="$PROJECT_DIR/.claude/logs/feature-$FEATURE_ISSUE"
mkdir -p "$LOG_DIR"

# Plan issue loaded lazily by detect_plan_issue() — from --plan-issue arg or .plan_issue state

# Fetch feature issue
echo -e "${BLUE}Fetching feature issue #${FEATURE_ISSUE}...${NC}"
FEATURE_TITLE=$(gh issue view "$FEATURE_ISSUE" --json title -q '.title' 2>/dev/null) || { echo -e "${RED}✗ Cannot fetch issue #${FEATURE_ISSUE}${NC}"; exit 1; }
FEATURE_BODY=$(gh issue view "$FEATURE_ISSUE" --json body -q '.body' 2>/dev/null) || FEATURE_BODY=""

echo -e "${BLUE}══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Feature Pipeline - $PROJECT_NAME${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓${NC} Feature: $FEATURE_TITLE (#$FEATURE_ISSUE)"
echo -e "${GREEN}✓${NC} Checks: $CHECK_CMD"
echo -e "${GREEN}✓${NC} Start: $START_PHASE"
[[ -n "$PLAN_ISSUE" ]] && echo -e "${GREEN}✓${NC} Plan: #$PLAN_ISSUE"
echo ""

# ── Escape string for sed replacement (handles &, \, |) ────────────────────────
# Escape string for embedding inside bash double-quoted assignment
bash_dq_escape() {
  local val="$1"
  val="${val//\\/\\\\}"
  val="${val//\"/\\\"}"
  val="${val//\$/\\$}"
  val="${val//\`/\\\`}"
  printf '%s' "$val"
}

# ── Validate plan issue is set (from --plan-issue or .plan_issue state) ────────
detect_plan_issue() {
  if [[ -n "$PLAN_ISSUE" ]]; then return; fi
  # Only load from persisted state — never auto-detect from CLAUDE.md
  # (CLAUDE.md may reference a different feature's plan issue)
  if [[ -f "$LOG_DIR/.plan_issue" ]]; then
    PLAN_ISSUE=$(cat "$LOG_DIR/.plan_issue")
    # Validate issue is still OPEN
    local _state
    _state=$(gh issue view "$PLAN_ISSUE" --json state -q '.state' 2>/dev/null || echo "MISSING")
    if [[ "$_state" != "OPEN" ]]; then
      echo -e "${YELLOW}⚠ Stale .plan_issue #$PLAN_ISSUE ($_state) — ignoring${NC}"
      rm -f "$LOG_DIR/.plan_issue"
      PLAN_ISSUE=""
    else
      echo -e "${GREEN}✓${NC} Loaded plan issue #$PLAN_ISSUE from state"
    fi
  fi
}

# ── Repomap generation (compact codebase overview for plan phase) ──────────────
generate_repomap() {
  cd "$PROJECT_DIR"
  echo "## Codebase Map"
  echo ""

  # Directory tree (L1 + auto-detected L2 dirs)
  echo "### Directory Structure"
  echo '```'
  find . -maxdepth 1 -type d -not -path './.git*' -not -path './node_modules*' -not -path './.claude*' -not -path './.venv*' | sort
  # Auto-detect interesting L2 dirs (src, lib, internal, api, app, etc.)
  for _dir in */src */lib */internal */api */app src lib internal api app; do
    [[ -d "$_dir" ]] && find "$_dir" -maxdepth 1 -type d 2>/dev/null
  done | sort -u | head -40
  echo '```'
  echo ""

  # Python signatures (any .py files in project)
  if find . -name "*.py" -not -path "./.venv/*" -not -path "*/node_modules/*" -maxdepth 4 2>/dev/null | head -1 | grep -q .; then
    echo "### Python Signatures"
    echo '```'
    grep -rn "^class \|^def \|^async def " --include="*.py" --exclude-dir=.venv --exclude-dir=node_modules . 2>/dev/null | head -40
    echo '```'
    echo ""
  fi

  # Go signatures
  if [[ -f "go.mod" ]] || find . -name "go.mod" -maxdepth 2 2>/dev/null | head -1 | grep -q .; then
    echo "### Go Signatures"
    echo '```'
    grep -rn "^func \|^type .*struct\|^type .*interface" --include="*.go" . 2>/dev/null | head -40
    echo '```'
    echo ""
  fi

  # TypeScript/JS/Vue components
  if [[ -f "package.json" ]] || find . -name "package.json" -maxdepth 2 -not -path "*/node_modules/*" 2>/dev/null | head -1 | grep -q .; then
    echo "### Components/Modules"
    echo '```'
    find . -name "*.vue" -o -name "*.tsx" -o -name "*.ts" 2>/dev/null | grep -v node_modules | grep -v '.d.ts' | sort | head -30
    echo '```'
    echo ""
  fi

  # Rust signatures
  if [[ -f "Cargo.toml" ]]; then
    echo "### Rust Signatures"
    echo '```'
    grep -rn "^pub fn \|^pub struct \|^pub enum \|^pub trait " --include="*.rs" . 2>/dev/null | head -40
    echo '```'
    echo ""
  fi
}

# ── Phase ordering ─────────────────────────────────────────────────────────────
should_run() {
  local phase=$1
  local phases=(plan build validate ship)
  local start_idx=0 phase_idx=0
  for i in "${!phases[@]}"; do
    [[ "${phases[$i]}" == "$START_PHASE" ]] && start_idx=$i
    [[ "${phases[$i]}" == "$phase" ]] && phase_idx=$i
  done
  [[ "$phase_idx" -ge "$start_idx" ]]
}

# ── PHASE 1: PLAN ─────────────────────────────────────────────────────────────
run_plan() {
  # Claim issue — skip if assigned to someone else
  local _assignees _me
  _me=$(gh api user -q '.login' 2>/dev/null || true)
  _assignees=$(gh issue view "$FEATURE_ISSUE" --json assignees -q '.assignees[].login' 2>/dev/null || true)
  if [[ -n "$_assignees" && "$_assignees" != *"$_me"* ]]; then
    echo -e "${YELLOW}⚠ Issue #$FEATURE_ISSUE assigned to $_assignees — skipping${NC}"
    exit 0
  fi
  if [[ -z "$_assignees" && -n "$_me" ]]; then
    gh issue edit "$FEATURE_ISSUE" --add-assignee "@me" 2>/dev/null || true
    echo -e "${GREEN}✓${NC} Claimed issue #$FEATURE_ISSUE"
  fi

  detect_plan_issue
  if [[ -n "$PLAN_ISSUE" ]]; then
    echo -e "${GREEN}✓${NC} Plan issue #$PLAN_ISSUE exists — skipping plan phase"
    return 0
  fi

  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}▶ Phase 1: Plan${NC}  Log: $LOG_DIR/plan.log"

  # Generate repomap for context
  local repomap
  repomap=$(generate_repomap 2>/dev/null || echo "(repomap generation failed)")

  local _plan_file
  _plan_file=$(mktemp)
  cat > "$_plan_file" << PROMPT
Working on $PROJECT_NAME at $PROJECT_DIR.
Feature: $FEATURE_TITLE (#$FEATURE_ISSUE) — $FEATURE_BODY

$repomap

YOUR ONLY JOB: Create a plan issue on GitHub. Do NOT write any code. Do NOT implement anything.

1. Read CLAUDE.md. Use the codebase map above to locate relevant files — do NOT explore broadly.

2. Read the specific files that will need changes (identified from the map).

3. Decompose into 2-4 logical chunks. Each chunk MUST have:
   - Files list (exact paths)
   - "What to build" description
   - Code snippets from existing files showing what to modify

4. Create GH issue titled "Plan: $FEATURE_TITLE (#$FEATURE_ISSUE)" with:
   - ## Progress checklist (- [ ] Chunk N: Name)
   - #### Chunk N: headers (regex must match: ^#{3,4} Chunk [0-9]+:)
   - Each chunk's files, description, and code context

5. After creating the issue, write ONLY the issue number to this file:
   echo ISSUE_NUMBER > $LOG_DIR/.plan_issue
   Example: echo 321 > $LOG_DIR/.plan_issue

6. Update CLAUDE.md status line: **Phase:** plan - Chunk 0/N - #ISSUE

CRITICAL: Do NOT write code, do NOT implement features, do NOT run tests.
Your output is a GitHub issue with a plan. Nothing else.
Do NOT ask questions. Do NOT stop.
PROMPT
  local prompt
  prompt=$(cat "$_plan_file")
  rm -f "$_plan_file"

  cd "$PROJECT_DIR"
  mkdir -p "$LOG_DIR"  # re-create if Claude CLI clobbered .claude/
  unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT 2>/dev/null || true
  if claude --dangerously-skip-permissions --max-turns 40 --fallback-model claude-sonnet-4-6 \
            -p "$prompt" \
            < /dev/null 2>&1 | tee "$LOG_DIR/plan.log"; then
    if grep -qE "max.turns|turn limit|Maximum number of turns" "$LOG_DIR/plan.log"; then
      echo -e "${RED}✗ Hit turn limit — output may be incomplete${NC}"; exit 1
    fi
    echo -e "${GREEN}✓ Plan phase done${NC}"
  else
    echo -e "${RED}✗ Plan phase failed — check $LOG_DIR/plan.log${NC}"; exit 1
  fi

  # ── Plan issue detection (ordered by reliability) ────────────────────────
  # 1. File written by Claude (most reliable — we told it to)
  if [[ -f "$LOG_DIR/.plan_issue" ]]; then
    PLAN_ISSUE=$(cat "$LOG_DIR/.plan_issue" | tr -d '[:space:]')
    echo -e "${GREEN}✓${NC} Plan issue from .plan_issue file: #$PLAN_ISSUE"
  fi

  # Validate candidate references this feature
  _validate_plan_candidate() {
    local _cand=$1
    [[ -z "$_cand" ]] && return 1
    [[ "$_cand" == "$FEATURE_ISSUE" ]] && return 0
    local _pb
    _pb=$(gh issue view "$_cand" --json title,body -q '.title + " " + .body' 2>/dev/null || true)
    [[ -z "$_pb" ]] && return 1
    echo "$_pb" | grep -qE "(#${FEATURE_ISSUE}[^0-9]|#${FEATURE_ISSUE}$|\(#${FEATURE_ISSUE}\)|issue ${FEATURE_ISSUE})"
  }

  if [[ -n "$PLAN_ISSUE" ]] && ! _validate_plan_candidate "$PLAN_ISSUE"; then
    echo -e "${YELLOW}⚠ .plan_issue #$PLAN_ISSUE doesn't reference feature #$FEATURE_ISSUE — trying fallbacks${NC}"
    PLAN_ISSUE=""
  fi

  # 2. Log grep fallbacks (if Claude didn't write the file)
  if [[ -z "$PLAN_ISSUE" ]]; then
    # URL: /issues/26
    PLAN_ISSUE=$(grep -oE '/issues/[0-9]+' "$LOG_DIR/plan.log" | grep -oE '[0-9]+' | tail -1 || true)
    _validate_plan_candidate "$PLAN_ISSUE" || PLAN_ISSUE=""
  fi
  if [[ -z "$PLAN_ISSUE" ]]; then
    # Bold markdown: Created #26
    PLAN_ISSUE=$(grep -oE '(Created|created|Plan|plan).*#[0-9]+' "$LOG_DIR/plan.log" | grep -oE '#[0-9]+' | tail -1 | tr -d '#' || true)
    _validate_plan_candidate "$PLAN_ISSUE" || PLAN_ISSUE=""
  fi
  if [[ -z "$PLAN_ISSUE" ]]; then
    # Broad: any #N, try each highest-to-lowest
    local _candidates
    _candidates=$(grep -oE '#[0-9]+' "$LOG_DIR/plan.log" | grep -oE '[0-9]+' | sort -rn | uniq || true)
    for _cand in $_candidates; do
      if _validate_plan_candidate "$_cand"; then
        PLAN_ISSUE="$_cand"
        break
      fi
    done
  fi

  # 3. Direct-build detection: Claude built the feature instead of planning
  if [[ -z "$PLAN_ISSUE" ]]; then
    local _changed_files
    _changed_files=$(git diff --name-only 2>/dev/null || true)
    if [[ -n "$_changed_files" ]]; then
      echo -e "${YELLOW}⚠ No plan issue found but Claude made code changes — treating feature #$FEATURE_ISSUE as plan${NC}"
      echo -e "${YELLOW}  Changed files: $(echo "$_changed_files" | head -5 | tr '\n' ' ')${NC}"
      # Commit the work so build phase doesn't lose it
      safe_git_add 2>/dev/null || true
      git -c core.hooksPath=/dev/null commit -m "direct-build: $FEATURE_TITLE (#$FEATURE_ISSUE)" 2>/dev/null || true
      PLAN_ISSUE="$FEATURE_ISSUE"
    fi
  fi

  [[ -z "$PLAN_ISSUE" ]] && echo -e "${RED}✗ Could not detect plan issue # referencing feature #$FEATURE_ISSUE${NC}" && exit 1

  # Persist for resume (overwrite with validated value)
  echo "$PLAN_ISSUE" > "$LOG_DIR/.plan_issue"
  echo -e "${GREEN}✓${NC} Plan issue: #$PLAN_ISSUE"
}

# ── PHASE 2: BUILD ─────────────────────────────────────────────────────────────
run_build() {
  detect_plan_issue
  [[ -z "$PLAN_ISSUE" ]] && echo -e "${RED}✗ No plan issue # — run plan phase first or pass --plan-issue N${NC}" && exit 1

  # Direct-build: Claude already built during plan phase — skip to validate
  if [[ "$PLAN_ISSUE" == "$FEATURE_ISSUE" ]]; then
    echo -e "${GREEN}✓${NC} Direct-build detected — skipping build phase (code already committed)"
    return 0
  fi

  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}▶ Phase 2: Build${NC}  Plan: #$PLAN_ISSUE"

  # Create branch from main (not from current branch — avoids stacking)
  cd "$PROJECT_DIR"

  # Clean dirty working tree from previous failed builds
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null || [[ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]]; then
    if [[ -n "${WORKTREE_PROJECT_DIR:-}" ]]; then
      echo -e "${YELLOW}⚠ Committing dirty state from previous failed build${NC}"
      safe_git_add 2>>"$LOG_DIR/build.log" || true
      git commit -m "wip: auto-save dirty state before feature-$FEATURE_ISSUE" 2>>"$LOG_DIR/build.log" || true
    else
      echo -e "${YELLOW}⚠ Stashing uncommitted changes from previous run${NC}"
      git stash push --include-untracked -m "auto-stash before feature-$FEATURE_ISSUE" 2>>"$LOG_DIR/build.log" || true
    fi
  fi

  local branch="$BRANCH_PREFIX/feature-$FEATURE_ISSUE"
  local base_branch
  base_branch=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}' || echo "main")
  if ! git rev-parse --verify "$branch" &>/dev/null; then
    git checkout "$base_branch" 2>>"$LOG_DIR/build.log" || { echo -e "${RED}✗ Cannot checkout $base_branch${NC}"; return 1; }
    git pull --ff-only 2>>"$LOG_DIR/build.log" || { echo -e "${RED}✗ Cannot pull $base_branch — see $LOG_DIR/build.log${NC}"; return 1; }
    git checkout -b "$branch" 2>>"$LOG_DIR/build.log" || { echo -e "${RED}✗ Cannot create branch $branch${NC}"; return 1; }
    echo -e "${GREEN}✓${NC} Branch: $branch (from $base_branch)"
  else
    git checkout "$branch" 2>>"$LOG_DIR/build.log" || { echo -e "${RED}✗ Cannot checkout $branch${NC}"; return 1; }
    echo -e "${GREEN}✓${NC} Switched to: $branch"
  fi

  # Generate run-plan.sh if missing
  local run_plan_script="$PROJECT_DIR/scripts/run-plan.sh"
  if [[ ! -f "$run_plan_script" ]]; then
    echo -e "${CYAN}  Generating run-plan.sh from template...${NC}"
    mkdir -p "$PROJECT_DIR/scripts"
    # Copy template then patch config lines via awk ENVIRON (sed breaks on " $ ` in CHECK_CMD)
    cp ~/.claude/templates/run-plan.sh "$run_plan_script"
    local _esc_pd _esc_cc
    _esc_pd=$(bash_dq_escape "$PROJECT_DIR")
    _esc_cc=$(bash_dq_escape "$CHECK_CMD")
    _L5='PROJECT_DIR="${WORKTREE_PROJECT_DIR:-'"$_esc_pd"'}"' \
    _L7='CHECK_CMD="'"$_esc_cc"'"' \
    awk 'NR==5{print ENVIRON["_L5"];next} NR==7{print ENVIRON["_L7"];next} {print}' \
      "$run_plan_script" > "${run_plan_script}.tmp" && mv "${run_plan_script}.tmp" "$run_plan_script"
    chmod +x "$run_plan_script"
    echo -e "${GREEN}✓${NC} Created $run_plan_script"
  fi

  # Run plan executor
  if "$run_plan_script" --issue "$PLAN_ISSUE" 2>&1 | tee "$LOG_DIR/build.log"; then
    echo -e "${GREEN}✓ Build phase done${NC}"
  else
    echo -e "${RED}✗ Build phase failed — check $LOG_DIR/build.log${NC}"; exit 1
  fi
}

# ── PHASE 3: VALIDATE (Sonnet + retry loop) ──────────────────────────────────
run_validate() {
  if [[ "$SKIP_VALIDATE" == "true" ]]; then
    echo -e "${YELLOW}⚠ Skipping validate phase${NC}"
    return 0
  fi

  local max_attempts=3
  local attempt=1
  local prev_errors=""

  while [[ $attempt -le $max_attempts ]]; do
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}▶ Phase 3: Validate (attempt $attempt/$max_attempts)${NC}  Log: $LOG_DIR/validate.log"

    local context=""
    if [[ -n "$prev_errors" ]]; then
      context="
Previous validate attempt failed. Remaining errors to fix:
\`\`\`
$prev_errors
\`\`\`"
    fi

    local prompt
    prompt=$(cat << PROMPT
At $PROJECT_DIR. Feature: $FEATURE_TITLE. Plan: #$PLAN_ISSUE.$context
1. Run: $CHECK_CMD. Fix all errors.
2. Check for pre-commit hooks (.claude/hooks/, .husky/, .git/hooks/). Run what they run (mypy, eslint, etc). Fix all errors — ship phase will fail if hooks fail.
3. Run tests: look for test scripts in package.json / Makefile / pyproject.toml. Fix failures.
4. Read modified files (git diff --name-only). Verify feature works e2e.
5. Fix breaking issues: crashes, null refs, missing awaits, auth holes, API mismatches.
6. Trace capabilities through all layers. Fix wiring gaps (dropped config, stale wrappers, shape mismatches).
7. Stage and commit all changes: git add -A && git -c core.hooksPath=/dev/null commit -m "validate: fix issues for $FEATURE_TITLE"
Skip perfectionism (style, naming, theoretical edge cases). Sequential mode.
Do NOT ask questions. Do NOT stop. Do NOT generate reports.
PROMPT
)

    cd "$PROJECT_DIR"
    unset CLAUDECODE 2>/dev/null || true
    claude --dangerously-skip-permissions --model claude-sonnet-4-6 --max-turns 40 \
              -p "$prompt" \
              < /dev/null 2>&1 | tee "$LOG_DIR/validate.log" || true

    # Commit partial fixes before gate check (preserves work across retries)
    cd "$PROJECT_DIR"
    if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
      safe_git_add
      git -c core.hooksPath=/dev/null commit -m "validate: attempt $attempt for $FEATURE_TITLE" 2>/dev/null || true
      echo -e "${GREEN}  ✓ Partial fixes committed${NC}"
    fi

    # Quality gate — the real test
    echo -e "${CYAN}  Quality gate after validate attempt $attempt...${NC}"
    if (cd "$PROJECT_DIR" && eval "$CHECK_CMD") > "$LOG_DIR/validate-gate.log" 2>&1; then
      echo -e "${GREEN}✓ Validate phase done (attempt $attempt)${NC}"
      return 0
    fi

    # Structured error context for next attempt
    local error_count
    error_count=$(grep -cE "error|Error|ERROR" "$LOG_DIR/validate-gate.log" 2>/dev/null || echo "?")
    prev_errors="$error_count errors remaining:
$(cat "$LOG_DIR/validate-gate.log")"
    echo -e "${YELLOW}⚠ $error_count errors after attempt $attempt — retrying${NC}"
    attempt=$((attempt + 1))
  done

  echo -e "${RED}✗ Validate failed after $max_attempts attempts — check $LOG_DIR/validate-gate.log${NC}"
  exit 1
}

# ── PHASE 4: SHIP (merge to target branch) ────────────────────────────────────
run_ship() {
  detect_plan_issue
  if [[ "$SKIP_SHIP" == "true" ]]; then
    echo -e "${GREEN}✓ Ship skipped (parallel mode)${NC}"
    return 0
  fi

  cd "$PROJECT_DIR"

  # Auto-detect target branch from remote HEAD
  local target_branch
  target_branch=$(git remote show origin 2>/dev/null | awk '/HEAD branch/{print $NF}')
  target_branch="${target_branch:-main}"

  # Direct-build: already on target, no merge needed — just push + close
  if [[ "$PLAN_ISSUE" == "$FEATURE_ISSUE" ]]; then
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}▶ Phase 4: Ship (direct-build, no merge)${NC}"

    # Auto-commit any leftover changes
    if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
      safe_git_add
      git -c core.hooksPath=/dev/null commit -m "chore: pre-ship cleanup for $FEATURE_TITLE" 2>/dev/null || true
    fi

    # Quality gate
    echo -e "${CYAN}  Running checks...${NC}"
    if ! (cd "$PROJECT_DIR" && eval "$CHECK_CMD") > "$LOG_DIR/ship-checks.log" 2>&1; then
      echo -e "${RED}✗ Checks failed — check $LOG_DIR/ship-checks.log${NC}"
      return 1
    fi
    echo -e "${GREEN}  ✓ Checks passed${NC}"

    # Push
    local current_branch
    current_branch=$(git branch --show-current)
    if ! git push origin "$current_branch" 2>>"$LOG_DIR/ship.log"; then
      echo -e "${RED}✗ Push failed — see $LOG_DIR/ship.log${NC}"
      return 1
    fi
    echo -e "${GREEN}  ✓ Pushed $current_branch${NC}"

    # Close feature issue
    gh issue close "$FEATURE_ISSUE" --comment "Direct-build pushed to $current_branch via $(git rev-parse --short HEAD)." 2>/dev/null || true
    gh issue edit "$FEATURE_ISSUE" --add-label "done" 2>/dev/null || true
    echo -e "${GREEN}  ✓ Issue #$FEATURE_ISSUE closed with 'done' label${NC}"
    return 0
  fi

  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}▶ Phase 4: Ship (merge to $target_branch)${NC}"

  local feature_branch
  feature_branch=$(git branch --show-current)

  # If on target/main (e.g. --start-phase ship), checkout the feature branch
  if [[ "$feature_branch" == "$target_branch" || "$feature_branch" == "main" || "$feature_branch" == "master" ]]; then
    local _expected_branch="$BRANCH_PREFIX/feature-$FEATURE_ISSUE"
    if git rev-parse --verify "$_expected_branch" &>/dev/null; then
      echo -e "${CYAN}  Checking out $_expected_branch...${NC}"
      git checkout "$_expected_branch" 2>>"$LOG_DIR/ship.log" || { echo -e "${RED}✗ Cannot checkout $_expected_branch${NC}"; return 1; }
      feature_branch="$_expected_branch"
    else
      echo -e "${RED}✗ On $feature_branch and no $_expected_branch branch found${NC}"
      return 1
    fi
  fi

  # Auto-commit any leftover changes (CLAUDE.md phase line, etc.)
  if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    echo -e "${CYAN}  Committing leftover changes...${NC}"
    safe_git_add
    if ! git -c core.hooksPath=/dev/null commit -m "chore: pre-ship cleanup for $FEATURE_TITLE" 2>>"$LOG_DIR/ship.log"; then
      echo -e "${RED}✗ Auto-commit failed — check git status${NC}"
      git status
      return 1
    fi
  fi

  # Final quality gate
  echo -e "${CYAN}  Running checks...${NC}"
  if ! (cd "$PROJECT_DIR" && eval "$CHECK_CMD") > "$LOG_DIR/ship-checks.log" 2>&1; then
    echo -e "${RED}✗ Checks failed — check $LOG_DIR/ship-checks.log${NC}"
    return 1
  fi
  echo -e "${GREEN}  ✓ Checks passed${NC}"
  cd "$PROJECT_DIR"

  # Guard: feature branch must have commits ahead of target
  if [[ -z "$(git log "$target_branch".."$feature_branch" --oneline 2>/dev/null)" ]]; then
    echo -e "${RED}✗ No new commits on $feature_branch — nothing to ship${NC}"
    return 1
  fi

  # Save pre-merge state for safe rollback
  local pre_merge_sha
  pre_merge_sha=$(git rev-parse "$target_branch" 2>/dev/null)

  # Switch to target and pull latest
  echo -e "${CYAN}  Switching to $target_branch...${NC}"
  git checkout "$target_branch" 2>>"$LOG_DIR/ship.log" || { echo -e "${RED}✗ Cannot checkout $target_branch${NC}"; return 1; }
  if ! git pull --ff-only origin "$target_branch" 2>>"$LOG_DIR/ship.log"; then
    echo -e "${RED}✗ $target_branch diverged from origin — cannot fast-forward. See $LOG_DIR/ship.log${NC}"
    git checkout "$feature_branch" 2>/dev/null || true
    return 1
  fi
  # Update pre_merge_sha after pull (this is what we rollback to)
  pre_merge_sha=$(git rev-parse HEAD)
  echo -e "${GREEN}  ✓ $target_branch up to date${NC}"

  # ── Rebase feature branch onto latest target (prevents cascade conflicts) ──
  echo -e "${CYAN}  Rebasing $feature_branch onto $target_branch...${NC}"
  git checkout "$feature_branch" 2>>"$LOG_DIR/ship.log" || { echo -e "${RED}✗ Cannot checkout $feature_branch${NC}"; return 1; }

  if ! git rebase "$target_branch" 2>>"$LOG_DIR/ship.log"; then
    # Loop: resolve conflicts commit-by-commit (multi-commit branches hit conflicts at each replay)
    local _rb_iter=0
    local _rb_max=20
    while true; do
      _rb_iter=$((_rb_iter + 1))
      if [[ $_rb_iter -gt $_rb_max ]]; then
        echo -e "${RED}✗ Rebase conflict loop exceeded $_rb_max iterations — aborting${NC}"
        git rebase --abort 2>/dev/null || true
        git checkout "$target_branch" 2>/dev/null || true
        return 1
      fi

      # 1. Check for unmerged files
      local _rb_conflicts _rb_non_trivial=""
      _rb_conflicts=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
      if [[ -z "$_rb_conflicts" ]]; then
        # No conflicts but rebase still in progress — try continue
        if GIT_EDITOR=true git rebase --continue 2>>"$LOG_DIR/ship.log"; then
          break
        fi
        # continue failed with no conflicts — abort
        echo -e "${RED}✗ Rebase --continue failed with no conflicts — aborting${NC}"
        git rebase --abort 2>/dev/null || true
        git checkout "$target_branch" 2>/dev/null || true
        return 1
      fi

      echo -e "${CYAN}  Rebase conflict resolution iteration $_rb_iter...${NC}"

      # 2. Auto-resolve trivial (CLAUDE.md, run-plan.sh) with --theirs
      _rb_non_trivial=""
      for _f in $_rb_conflicts; do
        if [[ "$_f" == "CLAUDE.md" || "$_f" == "scripts/run-plan.sh" ]]; then
          git checkout --theirs "$_f" 2>/dev/null || true
          git add "$_f" 2>/dev/null || true
        else
          _rb_non_trivial="$_rb_non_trivial $_f"
        fi
      done

      if [[ -n "$_rb_non_trivial" ]]; then
        # 3. Classify: resolvable (source) vs unresolvable (binary)
        local _rb_resolvable="" _rb_unresolvable=""
        for _f in $_rb_non_trivial; do
          case "$_f" in
            *.py|*.go|*.ts|*.tsx|*.vue|*.js|*.jsx|*.css|*.scss|*.html|*.yaml|*.yml|*.toml|*.json|*.sql|*.sh|*.jinja2|*.j2|*.md|*.txt|*.cfg|*.ini|*.conf)
              _rb_resolvable="$_rb_resolvable $_f" ;;
            *) _rb_unresolvable="$_rb_unresolvable $_f" ;;
          esac
        done

        if [[ -n "$_rb_unresolvable" ]]; then
          echo -e "${RED}✗ Rebase conflict in binary/generated files:$_rb_unresolvable — aborting${NC}"
          git rebase --abort 2>/dev/null || true
          git checkout "$target_branch" 2>/dev/null || true
          return 1
        fi

        # 4. LLM-resolve source files
        local _rb_context=""
        for _f in $_rb_resolvable; do
          _rb_context="$_rb_context
--- $_f ---
$(cat "$_f" 2>/dev/null)
"
        done

        echo -e "${YELLOW}⚠ Rebase conflict (iter $_rb_iter) in:$_rb_resolvable — LLM resolving${NC}"
        unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT 2>/dev/null || true
        claude --dangerously-skip-permissions --max-turns 15 --fallback-model claude-sonnet-4-6 \
               -p "At $PROJECT_DIR. Resolve rebase conflicts. Remove ALL conflict markers. Files:
$_rb_context
Read each file, resolve, write resolved version. Do NOT ask questions." \
               < /dev/null 2>&1 | tee "$LOG_DIR/rebase-resolve.log" || true

        # 5. Verify no conflict markers remain
        local _rb_still=""
        for _f in $_rb_resolvable; do
          if grep -qE '^(<{7}|={7}|>{7})' "$_f" 2>/dev/null; then
            _rb_still="$_rb_still $_f"
          fi
        done
        if [[ -n "$_rb_still" ]]; then
          echo -e "${RED}✗ Conflict markers remain:$_rb_still — aborting rebase${NC}"
          git rebase --abort 2>/dev/null || true
          git checkout "$target_branch" 2>/dev/null || true
          return 1
        fi

        # 6. git add resolved files
        for _f in $_rb_resolvable; do git add "$_f" 2>/dev/null || true; done
      fi

      # 7. git rebase --continue → if succeeds, break; if fails, loop
      if GIT_EDITOR=true git rebase --continue 2>>"$LOG_DIR/ship.log"; then
        echo -e "${GREEN}  ✓ Rebase continue succeeded (iter $_rb_iter)${NC}"
        break
      fi
      # continue failed — loop back to check for more conflicts
    done
  fi

  # Post-rebase quality gate
  echo -e "${CYAN}  Post-rebase checks...${NC}"
  if ! (cd "$PROJECT_DIR" && eval "$CHECK_CMD") > "$LOG_DIR/rebase-checks.log" 2>&1; then
    echo -e "${RED}✗ Checks failed after rebase — see $LOG_DIR/rebase-checks.log${NC}"
    git checkout "$target_branch" 2>/dev/null || true
    return 1
  fi
  echo -e "${GREEN}  ✓ Rebase clean, checks pass${NC}"

  # Switch back to target for merge
  git checkout "$target_branch" 2>>"$LOG_DIR/ship.log" || return 1

  # Merge feature branch (--no-ff for clean history, Refs not Closes to prevent auto-close)
  echo -e "${CYAN}  Merging $feature_branch into $target_branch...${NC}"
  if ! git merge --no-ff "$feature_branch" -m "Merge $feature_branch: $FEATURE_TITLE

Refs #$FEATURE_ISSUE. Plan: #$PLAN_ISSUE." 2>>"$LOG_DIR/ship.log"; then
    # Auto-resolve CLAUDE.md conflicts (expected in parallel mode — each branch writes its own phase line)
    # NOTE: `|| true` is critical — without it, `set -eo pipefail` kills the script on non-zero exit
    local _conflicts _non_trivial=""
    _conflicts=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
    for _f in $_conflicts; do
      if [[ "$_f" == "CLAUDE.md" || "$_f" == "scripts/run-plan.sh" ]]; then
        git checkout --ours "$_f" 2>/dev/null || true
        git add "$_f" 2>/dev/null || true
      else
        _non_trivial="$_non_trivial $_f"
      fi
    done
    if [[ -n "$_non_trivial" ]]; then
      echo -e "${YELLOW}⚠ Merge conflict in:$_non_trivial — attempting LLM resolution${NC}"

      # Filter: only attempt resolution on source files
      local _resolvable="" _unresolvable=""
      for _f in $_non_trivial; do
        case "$_f" in
          *.py|*.go|*.ts|*.tsx|*.vue|*.js|*.jsx|*.css|*.scss|*.html|*.yaml|*.yml|*.toml|*.json|*.sql|*.sh|*.jinja2|*.j2|*.md|*.txt|*.cfg|*.ini|*.conf)
            _resolvable="$_resolvable $_f" ;;
          *)
            _unresolvable="$_unresolvable $_f" ;;
        esac
      done

      if [[ -n "$_unresolvable" ]]; then
        echo -e "${RED}✗ Binary/generated conflicts in:$_unresolvable — aborting${NC}"
        git merge --abort 2>/dev/null || true
        git checkout "$feature_branch" 2>/dev/null || true
        return 1
      fi

      # Build conflict context
      local _conflict_context=""
      for _f in $_resolvable; do
        _conflict_context="$_conflict_context
--- $_f ---
$(cat "$_f" 2>/dev/null)
"
      done

      # Invoke Claude to resolve
      local _resolve_log="$LOG_DIR/merge-resolve.log"
      local _resolve_prompt="At $PROJECT_DIR. Resolve merge conflicts in these files. Preserve intent from BOTH sides. Remove ALL conflict markers (<<<<<<< ======= >>>>>>>).

Files with conflicts:
$_conflict_context

For each file: read it, resolve conflicts, write the resolved version. Do NOT ask questions."

      echo -e "${CYAN}  Running Claude merge resolution...${NC}"
      unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT 2>/dev/null || true
      claude --dangerously-skip-permissions --max-turns 15 --fallback-model claude-sonnet-4-6 \
             -p "$_resolve_prompt" \
             < /dev/null 2>&1 | tee "$_resolve_log" || true

      # Verify: no remaining conflict markers
      local _still_conflicted=""
      for _f in $_resolvable; do
        if grep -qE '^(<{7}|={7}|>{7})' "$_f" 2>/dev/null; then
          _still_conflicted="$_still_conflicted $_f"
        fi
      done

      if [[ -n "$_still_conflicted" ]]; then
        echo -e "${RED}✗ Conflict markers remain in:$_still_conflicted — aborting${NC}"
        git merge --abort 2>/dev/null || true
        git checkout "$feature_branch" 2>/dev/null || true
        return 1
      fi

      # Stage resolved files
      for _f in $_resolvable; do
        git add "$_f" 2>/dev/null || true
      done

      # Quality gate on resolved merge
      if ! (cd "$PROJECT_DIR" && eval "$CHECK_CMD") > "$LOG_DIR/merge-resolve-gate.log" 2>&1; then
        echo -e "${RED}✗ Quality checks failed after merge resolution — aborting${NC}"
        git merge --abort 2>/dev/null || true
        git checkout "$feature_branch" 2>/dev/null || true
        return 1
      fi
      echo -e "${GREEN}  ✓ LLM merge resolution succeeded${NC}"
      cd "$PROJECT_DIR"
    fi
    if ! git commit --no-edit 2>>"$LOG_DIR/ship.log"; then
      echo -e "${RED}✗ Merge commit failed — aborting${NC}"
      git merge --abort 2>/dev/null || true
      git checkout "$feature_branch" 2>/dev/null || true
      return 1
    fi
    echo -e "${GREEN}  ✓ Merge conflict resolved${NC}"
  fi
  echo -e "${GREEN}  ✓ Merged${NC}"

  # Post-merge quality gate — catch semantic conflicts from merge
  echo -e "${CYAN}  Post-merge checks...${NC}"
  if ! (cd "$PROJECT_DIR" && eval "$CHECK_CMD") > "$LOG_DIR/post-merge-gate.log" 2>&1; then
    cd "$PROJECT_DIR"
    echo -e "${RED}✗ Post-merge checks failed — rolling back. See $LOG_DIR/post-merge-gate.log${NC}"
    git reset --hard "$pre_merge_sha" 2>/dev/null || true
    git checkout "$feature_branch" 2>/dev/null || true
    return 1
  fi
  cd "$PROJECT_DIR"

  # Push target branch
  if ! git push origin "$target_branch" 2>>"$LOG_DIR/ship.log"; then
    echo -e "${RED}✗ Push $target_branch failed — rolling back local merge. See $LOG_DIR/ship.log${NC}"
    git reset --hard "$pre_merge_sha" 2>/dev/null || true
    git checkout "$feature_branch" 2>/dev/null || true
    return 1
  fi
  echo -e "${GREEN}  ✓ Pushed $target_branch${NC}"

  # Delete feature branch (local + remote)
  git branch -d "$feature_branch" 2>/dev/null || true
  git push origin --delete "$feature_branch" 2>/dev/null || true
  echo -e "${GREEN}  ✓ Deleted branch $feature_branch${NC}"

  # Close feature issue with 'done' label — ONLY after confirmed push
  gh issue close "$FEATURE_ISSUE" --comment "Merged to $target_branch via $(git rev-parse --short HEAD). Plan: #$PLAN_ISSUE" 2>/dev/null || true
  gh issue edit "$FEATURE_ISSUE" --add-label "done" 2>/dev/null || true
  echo -e "${GREEN}  ✓ Issue #$FEATURE_ISSUE closed with 'done' label${NC}"
}

# ── Main ───────────────────────────────────────────────────────────────────────
echo -e "${BLUE}Starting from phase: $START_PHASE${NC}\n"

should_run "plan"     && run_plan
should_run "build"    && run_build
should_run "validate" && run_validate
should_run "ship"     && run_ship

echo -e "\n${GREEN}══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Feature #$FEATURE_ISSUE complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
