# Agent Decisions

## 2026-07-29: Backport Shared Telegram Runtime Hardening

`/home/gnu/codex-cli-over-telegram` has accumulated operational improvements that also apply to this Claude service because both projects use a Telegram forum-topic service, SQLite bindings, per-topic run queueing, MarkdownV2 message splitting, and a local health endpoint.

Backport the shared behavior, not Codex-specific product surface:

- keep queue chains alive after task failures;
- retry Telegram sends across chat migrations, rate limits, and transient network failures;
- isolate restart recovery from stale-topic resume-notice failures;
- pack MarkdownV2 chunks before sending;
- batch consecutive short assistant prose messages.

Do not port Codex-specific bridge, fleet, work-item, cron, provider-tier, or app-server tooling into this Claude-only repo unless that product scope changes.

## 2026-07-29: Promote Claude Bot To Manager Peer

The product scope changed: this service should also have the fleet and manager/control-plane system from `codex-cli-over-telegram`.

Port the generic manager surface to Claude while keeping provider execution Claude-only:

- Persist observed topic messages, work items, cron jobs, and manager events in the Claude runtime SQLite database.
- Expose authenticated `/bridge` and `/manager/queue-topic` on the health server with `MANAGER_BRIDGE_TOKEN`.
- Run the in-service cron scheduler and queue due work through the same run queue as Telegram prompts.
- Provide fleet snapshot/restore/backup CLI commands with `claudeThreadId` treated as soft state.
- Include an MCP bridge binary for `telegram_manager` tools, but keep chat-id scoping deterministic from explicit env or the current repo path's binding. Do not discover bridge credentials from unrelated running processes.

Do not port Codex provider routing, app-server protocol, or token-usage accounting as part of this manager port.
