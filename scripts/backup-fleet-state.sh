#!/usr/bin/env bash
set -euo pipefail

app_dir="${APP_DIR:-/home/gnu/claude-cli-over-telegram}"
manager_repo="${MANAGER_REPO:-/home/gnu/claude-manager}"
database_path="${DATABASE_PATH:-/home/gnu/.local/state/claude-cli-over-telegram/state.sqlite}"
manifest_path="${FLEET_MANIFEST:-$manager_repo/fleet.json}"
push_flag="${PUSH_FLEET_BACKUP:-false}"
commit_flag="${COMMIT_FLEET_BACKUP:-false}"
recent_runs="${FLEET_RECENT_RUNS:-5}"

args=(
  fleet:backup
  --
  --manager-repo "$manager_repo"
  --manifest "$manifest_path"
  --database "$database_path"
  --recent-runs "$recent_runs"
)

if [ "$commit_flag" != "true" ]; then
  args+=(--no-commit)
fi

if [ "$push_flag" = "true" ]; then
  args+=(--push)
fi

npm --prefix "$app_dir" run "${args[@]}"
