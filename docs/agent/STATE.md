# Agent State

## 2026-07-29

- This repository implements the `claude-cli-over-telegram` Node.js service: a Telegram forum-topic controller for local Claude CLI sessions.
- The live Telegram bot is `@T4jsBot` and the bot token is stored only in `/etc/claude-cli-over-telegram/env`.
- The live service runs as the systemd unit `claude-cli-over-telegram.service` and is enabled.
- `/health` is served locally by `src/health.ts` on `http://127.0.0.1:8789/health` and exposes `branch`, `commitHash`, and `deployedAt` from deploy-time environment variables.
- `scripts/deploy.sh` writes `DEPLOY_BRANCH`, `DEPLOY_COMMIT_HASH`, and `DEPLOYED_AT` to `/etc/claude-cli-over-telegram/deploy.env`, restarts the systemd service, and verifies the configured `HEALTH_URL`.
- The service uses `/home/gnu/.local/state/claude-cli-over-telegram/state.sqlite` for runtime SQLite state.
- The service is configured with `ALLOWED_REPO_ROOTS=/home/gnu`, `CLAUDE_BIN=/home/gnu/.local/bin/claude`, `CLAUDE_ALWAYS_YOLO=true`, and `ALLOW_UNTHREADED_CHATS=true` to match the local Codex bot operating style.
- The manager/control-plane system is ported from `codex-cli-over-telegram` for this Claude bot:
  - Telegram commands: `/dashboard`, `/topics`, `/todo`, `/work`, `/work_add`, `/work_done`, `/work_blocked`, `/work_cancel`, `/queue_topic`, `/assign`, and `/cron`.
  - Authenticated HTTP bridge: `POST http://127.0.0.1:8789/bridge` with `MANAGER_BRIDGE_TOKEN` from `/etc/claude-cli-over-telegram/env`.
  - MCP bridge binary: `claude-telegram-manager-bridge-mcp`.
  - Fleet CLI: `npm run fleet:export`, `npm run fleet:restore`, and `npm run fleet:backup`.
  - Fleet backup units: `deploy/systemd/claude-cli-over-telegram-fleet-backup.service` and `.timer`.
  - Cron scheduler runs inside `claude-cli-over-telegram.service` every minute and queues due jobs through the same per-topic `RunQueue`.
- The live env stores `MANAGER_BRIDGE_URL=http://127.0.0.1:8789/bridge` and `MANAGER_REPO_PATH=/home/gnu/claude-manager`.
- `8787` is occupied by `codex-cli-over-telegram` and `8788` is occupied by `w7s-docker`, so this service uses health port `8789`.
- Deployment verified on 2026-07-29 with `NRestarts=0`, webhook URL empty, and polling active. Use live `/health` for the exact current `branch`, `commitHash`, and `deployedAt`.
- Backported useful operational hardening from `/home/gnu/codex-cli-over-telegram`:
  - run-queue task failures are logged and do not poison later queued work for the same topic;
  - restart recovery treats the Telegram resume notice as best-effort so stale or deleted topics do not block execution recovery;
  - Telegram send queue retries chat migrations, rate limits, and transient network failures;
  - long MarkdownV2 output is packed into full Telegram-safe chunks instead of many tiny messages;
  - consecutive short Claude assistant messages are batched before sending.
- Codex-specific bridge, fleet, work-item, cron, provider-tier, and app-server features remain out of scope for this Claude-only service unless explicitly requested.
