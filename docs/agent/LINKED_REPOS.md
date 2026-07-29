# Linked Repositories

## `/home/gnu/codex-cli-over-telegram`

The Codex bot is the closest sibling implementation and the source used on 2026-07-29 for shared operational hardening ideas.

Shared concepts:

- Telegram forum-topic bindings;
- SQLite `topic_bindings` and `runs` recovery state;
- per-topic run queues;
- Telegram send queue rate limiting;
- MarkdownV2 output splitting;
- local `/health` metadata with `branch`, `commitHash`, and `deployedAt`.

Boundaries:

- Claude repo owns Claude CLI execution and `claude_thread_id` recovery.
- Codex repo owns Codex provider orchestration, app-server bridge tools, fleet snapshots, work items, and cron management.
- Treat Claude/Codex thread IDs as soft state. Durable recovery knowledge belongs in repo files such as `docs/agent/STATE.md`.
