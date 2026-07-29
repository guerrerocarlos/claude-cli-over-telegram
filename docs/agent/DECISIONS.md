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
