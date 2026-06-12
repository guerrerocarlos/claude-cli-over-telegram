# Claude CLI over Telegram Implementation

## Goal

Run Claude Code from Telegram, with each Telegram forum topic bound to a local workspace folder.

```text
Telegram chat_id + message_thread_id -> repo path + Claude session + run queue
```

Each topic behaves like a separate Claude workspace console. Messages in that topic are routed to the bound folder and responses are posted back into the same topic.

## Runtime Model

- Node.js 20+
- TypeScript
- `grammy` for Telegram
- SQLite via `better-sqlite3`
- Claude Code through `claude --print --verbose --output-format stream-json`
- systemd for production service supervision

The bot is the network-facing process. Claude Code runs locally as child processes in trusted workspace directories.

## Telegram Model

The service requires:

```text
TELEGRAM_BOT_TOKEN=
ALLOWED_TELEGRAM_USER_IDS=
ALLOWED_TELEGRAM_CHAT_IDS=
ALLOWED_REPO_ROOTS=
```

If either allowlist is empty, the bot replies with the current user/chat IDs so the operator can configure the service.

Forum topics are preferred. `ALLOW_UNTHREADED_CHATS=true` lets Telegram's general topic map to `message_thread_id=0`.

## Workspace Binding

`/bind <path>` binds the current topic to a folder under `ALLOWED_REPO_ROOTS`.

`/create <folder>` creates or reuses a folder under the first allowed root, creates a Telegram forum topic, and binds that topic to the folder.

Repository paths are validated through `src/pathPolicy.ts` before use.

## Claude Backend

The backend adapter is `src/claudeExec.ts`.

New turns run:

```bash
claude --print --verbose --output-format stream-json "<prompt>"
```

Follow-up turns resume the stored Claude session:

```bash
claude --print --verbose --output-format stream-json --resume "$SESSION_ID" "<prompt>"
```

The adapter stores the Claude `session_id` from the stream `system:init` event in `topic_bindings.claude_thread_id`.

## Permission Mapping

Telegram modes map to Claude Code permission flags:

```text
read-only           -> --permission-mode dontAsk --disallowedTools Edit,Write,NotebookEdit
workspace-write     -> --permission-mode acceptEdits
danger-full-access  -> --permission-mode bypassPermissions --dangerously-skip-permissions
```

`CLAUDE_ALWAYS_YOLO=true` forces `danger-full-access` for all runs.

Plan mode appends local plan-mode instructions and starts Claude with `--permission-mode plan`.

## Queueing And Locks

Runs are queued per Telegram topic. The process also enforces a global `MAX_PARALLEL_RUNS` limit.

Write-capable modes acquire a SQLite repo lock before starting so two topics do not write to the same checkout concurrently.

If the service restarts while runs are queued or active, saved runs are requeued on startup. Interrupted running runs resume the stored Claude session with a continue-style recovery prompt.

## Health

The HTTP health server exposes:

```json
{
  "ok": true,
  "service": "claude-cli-over-telegram",
  "branch": "main",
  "commitHash": "...",
  "deployedAt": "2026-06-12T00:00:00Z"
}
```

`scripts/deploy.sh` writes `DEPLOY_BRANCH`, `DEPLOY_COMMIT_HASH`, and `DEPLOYED_AT` to `/etc/claude-cli-over-telegram/deploy.env` at deploy time.
