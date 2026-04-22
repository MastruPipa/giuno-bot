#!/usr/bin/env bash
# Post-merge setup: run after you've (1) merged the branch and (2) applied
# the migration from supabase_migration.sql. Executes the backfill + seed
# steps in the right order, with dry-runs first so nothing writes until
# you confirm the counts look sane.
#
# Requires in .env (or exported):
#   SUPABASE_URL
#   SUPABASE_SERVICE_KEY  (or SUPABASE_KEY)
#   SLACK_BOT_TOKEN
#
# Usage:
#   bash scripts/post-merge-setup.sh            # interactive, dry-run first
#   bash scripts/post-merge-setup.sh --apply    # skip dry-run, write immediately

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APPLY=false
if [ "${1:-}" = "--apply" ]; then APPLY=true; fi

echo "=================================================="
echo "  Giuno post-merge setup"
echo "  repo: $ROOT"
echo "  mode: $([ "$APPLY" = "true" ] && echo apply || echo interactive)"
echo "=================================================="
echo

check_env() {
  for var in SUPABASE_URL SLACK_BOT_TOKEN; do
    if [ -z "${!var:-}" ]; then
      if [ -f .env ] && grep -q "^$var=" .env; then
        continue
      fi
      echo "ERROR: $var not set in environment or .env"
      exit 1
    fi
  done
  if [ -z "${SUPABASE_SERVICE_KEY:-}" ] && [ -z "${SUPABASE_KEY:-}" ]; then
    if [ -f .env ] && ! grep -Eq "^(SUPABASE_SERVICE_KEY|SUPABASE_KEY)=" .env; then
      echo "ERROR: neither SUPABASE_SERVICE_KEY nor SUPABASE_KEY in env/.env"
      exit 1
    fi
  fi
}

check_env

run_step() {
  local label="$1"; shift
  local cmd="$*"
  echo "--- $label ---"
  if [ "$APPLY" = "true" ]; then
    echo ">>> $cmd"
    eval "$cmd"
  else
    echo ">>> $cmd --dry-run"
    eval "$cmd --dry-run"
    echo
    read -p "    Looks good? Apply this step? [y/N] " confirm
    if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
      eval "$cmd"
    else
      echo "    Skipped."
    fi
  fi
  echo
}

echo "Step 1 — Seed team roster (Peppe/Giusy/Claudia disambiguation)"
run_step "seed-team-roster" "node scripts/seed-team-roster.js"

echo "Step 2 — Backfill memories.content_hash"
run_step "backfill-content-hash" "node scripts/backfill-content-hash.js"

echo "Step 3 — Backfill memories.thread_ts / knowledge_base.source_thread_ts from tag patterns"
run_step "backfill-thread-ts" "node scripts/backfill-thread-ts.js"

echo "Step 4 — Backfill thread_ts from Slack API (last 90 days)"
run_step "backfill-thread-ts-from-slack" "node scripts/backfill-thread-ts-from-slack.js --days=90"

echo "=================================================="
echo "  Done. Now restart the bot so it picks up:"
echo "    - the new team_members cache (loadTeamRoster)"
echo "    - the new personal digest / memory backup / decay / followup crons"
echo "=================================================="
