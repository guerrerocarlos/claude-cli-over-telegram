# Agent Runbook

## Install And Test

```bash
npm ci
npm test
npm run build
npm run fleet
```

`npm test` runs TypeScript typecheck with `tsc -p tsconfig.json --noEmit`.

## Health Check

```bash
curl -fsS http://127.0.0.1:8789/health
```

Expected production metadata fields:

- `branch`
- `commitHash`
- `deployedAt`

Local development may return `unknown` for deployment metadata. On this host, `8787` is used by `codex-cli-over-telegram` and `8788` is used by `w7s-docker`, so the Claude bot uses `8789`.

## Deploy

```bash
./scripts/deploy.sh
```

The deploy script runs install, test, build, writes `/etc/claude-cli-over-telegram/deploy.env`, installs or refreshes the systemd unit, restarts `claude-cli-over-telegram.service`, and verifies `/health`.

Useful overrides:

```bash
SERVICE_USER=gnu \
SERVICE_GROUP=gnu \
APP_DIR=/home/gnu/claude-cli-over-telegram \
ENV_DIR=/etc/claude-cli-over-telegram \
STATE_DIR=/home/gnu/.local/state/claude-cli-over-telegram \
HEALTH_URL=http://127.0.0.1:8789/health \
./scripts/deploy.sh
```

On this host, deploy with the live health port:

```bash
HEALTH_URL=http://127.0.0.1:8789/health ./scripts/deploy.sh
```

## Service Status

```bash
systemctl is-active claude-cli-over-telegram.service
systemctl is-enabled claude-cli-over-telegram.service
systemctl status claude-cli-over-telegram.service --no-pager
journalctl -u claude-cli-over-telegram.service -f
```

The packaged production unit is `deploy/systemd/claude-cli-over-telegram.service`.

## Telegram Bot

The live bot username is `@T4jsBot`. Keep the token out of repo files; it belongs in `/etc/claude-cli-over-telegram/env`.

When topics are enabled on a newly created group, Telegram may upgrade it to a supergroup and assign a new chat id. If messages stop doing anything after enabling topics, inspect `audit_events` for `unauthorized_chat` and add the new `chat_id` to `ALLOWED_TELEGRAM_CHAT_IDS`, then restart or redeploy the service.

If topic messages are sent as an anonymous admin, Telegram reports the sender as `GroupAnonymousBot` (`1087968824`). Inspect `audit_events` for `unauthorized_message`; either disable anonymous admin posting in Telegram or include `1087968824` in `ALLOWED_TELEGRAM_USER_IDS`.

Verify Telegram API and polling/webhook state without printing secrets:

```bash
TOKEN="$(sudo awk -F= '$1 == "TELEGRAM_BOT_TOKEN" { print $2 }' /etc/claude-cli-over-telegram/env)"
curl -fsS "https://api.telegram.org/bot${TOKEN}/getMe"
curl -fsS "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"
```

The expected webhook URL is empty because the service uses long polling.

## Manager Bridge

The HTTP bridge is protected by `MANAGER_BRIDGE_TOKEN` in `/etc/claude-cli-over-telegram/env`.

List bound topics through the bridge:

```bash
TOKEN="$(sudo awk -F= '$1 == "MANAGER_BRIDGE_TOKEN" { print $2 }' /etc/claude-cli-over-telegram/env)"
curl -fsS \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"list_topics","chatId":-1004361900873}' \
  http://127.0.0.1:8789/bridge
```

Available bridge actions:

- `list_topics`
- `queue_topic`
- `read_topic_messages`
- `create_topic`
- `create_cron`
- `list_crons`
- `delete_cron`
- `create_work_item`
- `list_work_items`
- `update_work_item`
- `complete_work_item`

The MCP bridge binary is `claude-telegram-manager-bridge-mcp`. It reads `/etc/claude-cli-over-telegram/env`, uses `MANAGER_BRIDGE_URL`/`MANAGER_BRIDGE_TOKEN`, and infers chat scope from `MANAGER_BRIDGE_CHAT_ID` or the current repo path's live binding. It does not inspect other process environments.

## Cron Scheduler

Cron jobs live in the runtime SQLite table `cron_jobs` and are evaluated by the service every minute.

Telegram commands:

```text
/cron 0 * * * * check this topic
/cron topic-name 0 9 * * 1-5 summarize open work
/cron list
/cron off 3
```

The scheduler queues due prompts through the same per-topic run queue used by Telegram messages, so restarts recover queued/running work through the normal startup path.

## Fleet CLI

Export a sanitized snapshot:

```bash
npm run build
npm run fleet:export -- \
  --database /home/gnu/.local/state/claude-cli-over-telegram/state.sqlite \
  --out /home/gnu/claude-manager/snapshots/telegram-state/latest.json
```

Backup into a manager repo:

```bash
npm run fleet:backup -- \
  --manager-repo /home/gnu/claude-manager \
  --database /home/gnu/.local/state/claude-cli-over-telegram/state.sqlite \
  --no-commit
```

Systemd backup units are available but not enabled by default:

```bash
sudo cp deploy/systemd/claude-cli-over-telegram-fleet-backup.service /etc/systemd/system/
sudo cp deploy/systemd/claude-cli-over-telegram-fleet-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-cli-over-telegram-fleet-backup.timer
```

The unit writes to `/home/gnu/claude-manager` and defaults to `PUSH_FLEET_BACKUP=false` until that manager repo is intentionally initialized.

Check the timer:

```bash
systemctl is-enabled claude-cli-over-telegram-fleet-backup.timer
systemctl show claude-cli-over-telegram-fleet-backup.timer \
  -p ActiveState -p UnitFileState -p NextElapseUSecRealtime --no-pager
```

## Inspect Active Runs

```bash
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('/home/gnu/.local/state/claude-cli-over-telegram/state.sqlite', { readonly: true });
console.log(JSON.stringify(db.prepare(`
  SELECT r.id, r.binding_id, b.topic_name, b.chat_id, b.message_thread_id,
         b.repo_path, r.status, r.started_at, r.completed_at, r.error_message,
         substr(r.prompt, 1, 240) AS prompt
  FROM runs r
  JOIN topic_bindings b ON b.id = r.binding_id
  WHERE r.status IN ('queued', 'running')
  ORDER BY r.id
`).all(), null, 2));
NODE
```

## Inspect Telegram Send Problems

```bash
journalctl -u claude-cli-over-telegram.service -n 200 --no-pager -o short-iso \
  | rg 'migrate_to_chat_id|group chat was upgraded|telegram chat migrated|message thread not found|failed to send restart resume notice|run queue task failed'
```

Permanent Telegram errors such as `message thread not found` usually mean a bound topic was deleted or the binding points at the wrong group. They should not crash service startup, but they still require live SQLite cleanup.

Inspect the affected binding/run:

```bash
RUN_ID=1
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('/home/gnu/.local/state/claude-cli-over-telegram/state.sqlite', { readonly: true });
const runId = Number(process.env.RUN_ID);
console.log(JSON.stringify(db.prepare(`
  SELECT r.id, r.status, r.error_message, b.id AS binding_id, b.topic_name,
         b.chat_id, b.message_thread_id, b.repo_path
  FROM runs r
  JOIN topic_bindings b ON b.id = r.binding_id
  WHERE r.id = ?
`).get(runId), null, 2));
NODE
```
