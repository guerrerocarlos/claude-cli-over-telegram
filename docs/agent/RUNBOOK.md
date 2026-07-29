# Agent Runbook

## Install And Test

```bash
npm ci
npm test
npm run build
```

`npm test` runs TypeScript typecheck with `tsc -p tsconfig.json --noEmit`.

## Health Check

```bash
curl -fsS http://127.0.0.1:8787/health
```

Expected production metadata fields:

- `branch`
- `commitHash`
- `deployedAt`

Local development may return `unknown` for deployment metadata.

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
HEALTH_URL=http://127.0.0.1:8787/health \
./scripts/deploy.sh
```

## Service Status

```bash
systemctl is-active claude-cli-over-telegram.service
systemctl is-enabled claude-cli-over-telegram.service
systemctl status claude-cli-over-telegram.service --no-pager
journalctl -u claude-cli-over-telegram.service -f
```

The packaged production unit is `deploy/systemd/claude-cli-over-telegram.service`.

## Inspect Active Runs

```bash
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('data/state.sqlite', { readonly: true });
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
const db = new Database('data/state.sqlite', { readonly: true });
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
