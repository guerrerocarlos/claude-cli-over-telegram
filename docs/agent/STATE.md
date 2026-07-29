# Agent State

## 2026-07-29

- This repository implements the `claude-cli-over-telegram` Node.js service: a Telegram forum-topic controller for local Claude CLI sessions.
- `/health` is served locally by `src/health.ts` and exposes `branch`, `commitHash`, and `deployedAt` from deploy-time environment variables.
- `scripts/deploy.sh` writes `DEPLOY_BRANCH`, `DEPLOY_COMMIT_HASH`, and `DEPLOYED_AT` to `/etc/claude-cli-over-telegram/deploy.env`, restarts the systemd service, and verifies `http://127.0.0.1:8787/health`.
- Backported useful operational hardening from `/home/gnu/codex-cli-over-telegram`:
  - run-queue task failures are logged and do not poison later queued work for the same topic;
  - restart recovery treats the Telegram resume notice as best-effort so stale or deleted topics do not block execution recovery;
  - Telegram send queue retries chat migrations, rate limits, and transient network failures;
  - long MarkdownV2 output is packed into full Telegram-safe chunks instead of many tiny messages;
  - consecutive short Claude assistant messages are batched before sending.
- Codex-specific bridge, fleet, work-item, cron, provider-tier, and app-server features remain out of scope for this Claude-only service unless explicitly requested.
